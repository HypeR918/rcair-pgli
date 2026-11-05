import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIsolated } from './helpers/isolated.mjs';

async function bootstrap(t, fail = false) {
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

test('webhook подключается после схемы/сессий/хендлеров; GLPI polling сохраняется; shutdown закрывает транспорт до БД', async t => {
  const f = await bootstrap(t);
  assert.deepEqual(f.calls, [
    'validate', 'schema', 'sessions', 'cleanup', 'user-handlers', 'message-handler', 'ticket-actions', 'transport',
  ]);
  f.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.slice(-2), ['sds:10000', 'tickets:20000']);
  await f.signals.get('SIGTERM')();
  assert.deepEqual(f.calls.slice(-4), ['stop-transport', 'kill-glpi-session', 'close-db', 'exit:0']);
  await f.signals.get('SIGINT')();
  assert.equal(f.calls.filter(call => call === 'exit:0').length, 1);
});

test('ошибка запуска MAX не запускает фоновые GLPI-опросы и завершает процесс с ошибкой', async t => {
  const f = await bootstrap(t, true);
  f.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1), 'exit:1');
  assert(!f.calls.some(call => call.startsWith('sds:') || call.startsWith('tickets:')));
});
