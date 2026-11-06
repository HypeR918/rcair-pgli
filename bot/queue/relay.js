import { connectRabbit } from './rabbit.js';

export function startEventRelay(store, config, { intervalMs = 1000, logger = console, connect = connectRabbit } = {}) {
  let rabbit;
  let stopped = false;
  let running;
  const state = { connected: false, published: 0, last_error: null };
  async function tick() {
    try {
      if (!rabbit?.connected) {
        rabbit = await connect(config, { onClose() { state.connected = false; } });
      }
      state.connected = rabbit.connected;
      await store.recoverExpired();
      for (const event of await store.publishable()) {
        if (stopped) break;
        await rabbit.publish(event.id);
        await store.markPublished(event.id, event.attempts);
        state.published++;
      }
      state.last_error = null;
    } catch {
      if (!state.last_error) logger.warn('[EVENT_RELAY] повтор соединения или публикации');
      state.last_error = 'RELAY_UNAVAILABLE';
      state.connected = Boolean(rabbit?.connected);
    }
  }
  const pump = () => {
    if (!stopped && !running) running = tick().finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(pump, intervalMs);
  timer.unref();
  pump();
  return {
    snapshot: () => ({ ...state }),
    async stop() {
      stopped = true; clearInterval(timer);
      await running;
      await rabbit?.close();
    },
  };
}
