import { randomUUID } from 'node:crypto';
import { createOperationScope } from '../utils/operationContext.js';

export async function startEventWorker(store, rabbit, handle, { logger = console, heartbeatMs = 10000 } = {}) {
  const owner = randomUUID();
  const active = new Map();
  const deliveries = new Set();
  let stopping = false;
  const execute = async id => {
    if (stopping) return;
    const claimed = await store.claim(id, owner);
    if (stopping) return; // Pre-start claim безопасно восстановит relay по lease.
    if (!claimed) return;
    if (claimed.invalid) return { dead: true };
    const state = { phase: 'worker.start', started: Date.now() };
    let release;
    state.done = new Promise(resolve => { release = resolve; });
    active.set(id, state);
    const replies = { attempted: 0, confirmed: 0, failed: 0 };
    const scope = createOperationScope(phase => { state.phase = phase; }, result => { replies[result]++; });
    const timing = () => {
      const duration = Math.max(0, Date.now() - state.started);
      return { queue_wait_ms: claimed.queueWaitMs ?? null, duration_ms: duration,
        total_ms: Number.isFinite(claimed.queueWaitMs) ? claimed.queueWaitMs + duration : null };
    };
    let started = false;
    let handled = false;
    const timer = setInterval(() => store.renewLease(id, owner).catch(() => {}), heartbeatMs);
    timer.unref();
    try {
      if (!await store.markStarted(id, owner)) return;
      started = true;
      await scope.run(() => handle(claimed.update));
      if (scope.ambiguousEffects.length) {
        const error = new Error('Неизвестен результат внешней записи'); error.code = 'EXTERNAL_WRITE_UNCERTAIN'; throw error;
      }
      handled = true;
      const ok = await store.complete(id, owner);
      if (!ok) { const error = new Error('Потеряно владение событием'); error.code = 'EVENT_LEASE_LOST'; throw error; }
      logger.log('[EVENT_WORKER]', JSON.stringify({ id, type: claimed.update.update_type, state: 'done', ...timing(), replies }));
    } catch (error) {
      if (started) {
        if (claimed.retrySafe && !handled && !scope.ambiguousEffects.length) {
          const result = await store.retrySafe(id, owner, error.code);
          logger.warn?.('[EVENT_WORKER]', JSON.stringify({ id, type: claimed.update.update_type, state: result,
            code: 'SAFE_COMMAND_RETRY', ...timing() }));
          return { dead: result !== 'pending' };
        }
        const status = handled || scope.ambiguousEffects.length ? 'uncertain' : 'failed';
        await store.fail(id, owner, error.code, status);
        logger.error('[EVENT_WORKER]', JSON.stringify({ id, type: claimed.update.update_type, state: status,
          code: /^[A-Z0-9_.-]{1,64}$/.test(error.code || '') ? error.code : 'EVENT_HANDLER_FAILED',
          phase: scope.failedPhase || state.phase, ...timing(), replies }));
      }
      return { dead: true };
    } finally {
      clearInterval(timer); active.delete(id); release();
    }
  };
  await rabbit.consume(id => {
    const task = execute(id);
    deliveries.add(task);
    task.finally(() => deliveries.delete(task)).catch(() => {});
    return task;
  });
  return {
    snapshot: () => ({ owner, connected: rabbit.connected, pending_callbacks: deliveries.size, active: [...active].map(([id, entry]) =>
      ({ id, phase: entry.phase, age_ms: Date.now() - entry.started })) }),
    async stop() {
      stopping = true;
      try { await rabbit.cancel(); } catch {}
      await Promise.allSettled([...deliveries]);
      await rabbit.close();
    },
  };
}
