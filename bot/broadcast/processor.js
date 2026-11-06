import { setTimeout as delay } from 'node:timers/promises';
import { createMaxClient } from '../transport/maxClient.js';
import { recordAmbiguousEffect, recordMaxReply } from '../utils/operationContext.js';
import { connectRabbit } from '../queue/rabbit.js';
import { startEventRelay } from '../queue/relay.js';
import { startEventWorker } from '../queue/worker.js';

export function createBroadcastSender(token, { rate = 2, client = createMaxClient(token), now = Date.now, sleep = delay } = {}) {
  if (!Number.isInteger(rate) || rate < 1 || rate > 5) throw new Error('BROADCAST_RATE_PER_SECOND: 1–5');
  let next = 0;
  return async update => {
    if (next > now()) await sleep(next - now());
    next = now() + Math.ceil(1000 / rate);
    recordMaxReply('attempted');
    try {
      let result;
      try {
        result = await client.call({ method: 'messages', options: { method: 'POST',
          query: { user_id: update.user.user_id }, body: { text: update.text } } });
      } catch (error) { recordAmbiguousEffect('max.broadcast.send'); throw error; }
      if (result.status === 429) { const error = new Error('MAX rate limit'); error.code = 'BROADCAST_RATE_LIMIT'; throw error; }
      const mid = result.data?.message?.body?.mid;
      if (result.status >= 500 || result.status >= 200 && result.status < 300 && (typeof mid !== 'string' || !mid)) {
        recordAmbiguousEffect('max.broadcast.send');
        const error = new Error('MAX не подтвердил результат отправки'); error.code = 'BROADCAST_SEND_UNCERTAIN'; throw error;
      }
      if (result.status < 200 || result.status >= 300) {
        const error = new Error('MAX отклонил отправку'); error.code = `BROADCAST_HTTP_${result.status}`; throw error;
      }
      recordMaxReply('confirmed');
    } catch (error) { recordMaxReply('failed'); throw error; }
  };
}

export function startBroadcastProcessor(store, config, token, { rate = 2, logger = console, connect = connectRabbit } = {}) {
  const queueConfig = { ...config, queue: `${config.queue}.broadcast`, prefetch: 1, relayIntervalMs: 1000 };
  const send = createBroadcastSender(token, { rate });
  const relay = startEventRelay(store, queueConfig, { logger, connect });
  const log = { log: (_tag, body) => logger.log('[BROADCAST_WORKER]', body),
    warn: (_tag, body) => logger.warn('[BROADCAST_WORKER]', body),
    error: (_tag, body) => logger.error('[BROADCAST_WORKER]', body) };
  let worker;
  let stopped = false;
  let starting;
  let lastError = null;
  async function start() {
    let rabbit;
    try {
      await worker?.stop();
      rabbit = await connect(queueConfig);
      if (stopped) { await rabbit.close(); return; }
      worker = await startEventWorker(store, rabbit, send, { logger: log });
      lastError = null;
    } catch {
      await rabbit?.close().catch(() => {});
      lastError = 'BROADCAST_WORKER_UNAVAILABLE';
      logger.warn('[BROADCAST_WORKER] повтор подключения');
    }
  }
  const pump = () => {
    if (!stopped && !starting && !worker?.snapshot().connected) {
      starting = start().finally(() => { starting = null; });
    }
  };
  const timer = setInterval(pump, 1000);
  timer.unref(); pump();
  return {
    snapshot: () => ({ connected: Boolean(worker?.snapshot().connected), rate_per_second: rate,
      last_error: lastError, relay: relay.snapshot(), active: worker?.snapshot().active || [] }),
    async stop() {
      stopped = true; clearInterval(timer);
      await starting;
      await Promise.allSettled([worker?.stop(), relay.stop()]);
    },
  };
}
