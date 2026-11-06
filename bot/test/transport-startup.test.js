import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIsolated } from './helpers/isolated.mjs';

async function bootstrap(t, role = 'webhook', fail = false) {
  const calls = [];
  const signals = new Map();
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const transportEntered = new Promise(resolve => { entered = resolve; });
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const timer = () => {
    const value = setInterval(() => {}, 60000);
    value.unref(); timers.push(value); return value;
  };
  await loadIsolated('index.js', {
    'node:process': { default: {
      env: {},
      on: (signal, handler) => signals.set(signal, handler),
      exit: code => calls.push(`exit:${code}`),
    } },
    './config/env.js': { env: {
      BOT_TOKEN: 'offline', BOT_TRANSPORT: 'webhook', PORT: 3000,
      GLPI_APPROVAL_POLL_MS: 10000, GLPI_TICKET_POLL_MS: 20000,
    }, requireEnv: () => calls.push('validate') },
    './services/dbService.js': {
      ensureDatabaseSchema: async () => calls.push('schema'), closeDb: async () => calls.push('close-db'),
    },
    './services/glpiService.js': { killCurrentSession: async () => calls.push('kill-glpi-session') },
    './controllers/sdsController.js': { handleApprovedSdsRequest: async () => {}, handleRejectedSdsRequest: async () => {} },
    './queue/config.js': { readQueueConfig: () => ({ role }) },
    './queue/resources.js': { createQueueResources: () => ({
      store: { ensureSchema: async () => calls.push('event-schema'), accept: async () => ({ id: '1' }) },
      pool: { end: async () => calls.push('close-events') },
      acquireWorkerLock: async () => { calls.push('worker-lock'); return async () => calls.push('release-lock'); },
    }) },
    './queue/relay.js': { startEventRelay: () => { calls.push('relay'); return { snapshot: () => ({}), stop: async () => calls.push('stop-relay') }; } },
    './queue/rabbit.js': { connectRabbit: async () => { calls.push('rabbit'); return { close: async () => calls.push('close-rabbit') }; } },
    './queue/worker.js': { startEventWorker: async () => {
      calls.push('worker'); entered(); await gate;
      if (fail) throw new Error('offline consumer failure');
      return { snapshot: () => ({ connected: true }), stop: async () => calls.push('stop-worker') };
    } },
    './queue/statusServer.js': { startWorkerStatus: async () => {
      calls.push('worker-health'); return { stop: async () => calls.push('stop-worker-health') };
    } },
    './transport/maxApi.js': { createMaxApi: () => async () => { calls.push('me'); return { user_id: 999 }; } },
    './state/sessionStore.js': { loadAllSessions: async () => calls.push('sessions') },
    './services/maxFileService.js': { startAttachmentCleanup: async () => { calls.push('cleanup'); return timer(); } },
    './controllers/userController.js': { registerUserHandlers: () => calls.push('user-handlers') },
    './controllers/messageController.js': { registerMessageHandler: () => calls.push('message-handler') },
    './controllers/ticketController.js': { registerTicketActions: () => calls.push('ticket-actions') },
    './transport/maxTransport.js': { startMaxTransport: async (_bot, config) => {
      assert.equal(config.BOT_TRANSPORT, 'webhook');
      calls.push('transport'); entered(); await gate;
      if (fail) throw new Error('simulated MAX unavailable');
      return { stop: async () => calls.push('stop-transport') };
    } },
    './polling/sdsPolling.js': { startSdsPolling: (_bot, interval) => { calls.push(`sds:${interval}`); return timer(); } },
    './polling/ticketPolling.js': { startTicketPolling: (_bot, interval) => { calls.push(`tickets:${interval}`); return timer(); } },
  });
  await transportEntered;
  return { calls, signals, release };
}

test('ingress подготавливает inbox и relay; не загружает сессии и не запускает GLPI polling', async t => {
  const f = await bootstrap(t);
  assert.deepEqual(f.calls, [
    'validate', 'event-schema', 'transport',
  ]);
  f.release();
  await new Promise(resolve => setImmediate(resolve));
  assert(!f.calls.some(call => call.startsWith('sds:') || call === 'sessions' || call === 'schema'));
  await f.signals.get('SIGTERM')();
  assert.deepEqual(f.calls.slice(-4), ['stop-transport', 'close-db', 'close-events', 'exit:0']);
  await f.signals.get('SIGINT')();
  assert.equal(f.calls.filter(call => call === 'exit:0').length, 1);
});

test('worker владеет сессиями и поллерами; запуск задач после захвата worker lock и consumer', async t => {
  const f = await bootstrap(t, 'worker');
  assert.deepEqual(f.calls, ['validate', 'event-schema', 'worker-lock', 'rabbit', 'schema', 'sessions',
    'user-handlers', 'message-handler', 'ticket-actions', 'me', 'worker']);
  f.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.slice(-5), ['relay', 'worker-health', 'cleanup', 'sds:10000', 'tickets:20000']);
  assert(!f.calls.includes('transport'));
  await f.signals.get('SIGTERM')();
  assert(f.calls.indexOf('stop-worker') < f.calls.indexOf('close-db'));
  assert(f.calls.includes('release-lock'));
});

test('ошибка consumer не запускает фоновые GLPI-опросы и завершает worker с ошибкой', async t => {
  const f = await bootstrap(t, 'worker', true);
  f.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1), 'exit:1');
  assert(!f.calls.some(call => call.startsWith('sds:') || call.startsWith('tickets:')));
});
