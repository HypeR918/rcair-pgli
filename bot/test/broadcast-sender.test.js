import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastSender, startBroadcastProcessor } from '../broadcast/processor.js';
import { createOperationScope } from '../utils/operationContext.js';

const update = { user: { user_id: '123' }, text: 'Обычный текст' };
test('рассылка ограничена двумя отправками в секунду без изменения текста', async () => {
  let now = 1000;
  const calls = [];
  const send = createBroadcastSender('offline', { rate: 2, now: () => now,
    sleep: async ms => { now += ms; }, client: { call: async args => {
      calls.push({ now, args }); return { status: 200, data: { message: { body: { mid: 'offline' } } } };
    } },
  });
  await send(update); await send(update); await send(update);
  assert.deepEqual(calls.map(call => call.now), [1000, 1500, 2000]);
  assert.deepEqual(calls[0].args.options, { method: 'POST', query: { user_id: '123' }, body: { text: 'Обычный текст' } });
  assert.throws(() => createBroadcastSender('offline', { rate: 100 }), /BROADCAST_RATE/);
});

test('только 429 безопасен для повтора; network, 5xx и неподтверждённый успех требуют проверки', async () => {
  for (const [result, ambiguous, code] of [
    [{ status: 429 }, false, 'BROADCAST_RATE_LIMIT'],
    [{ status: 403 }, false, 'BROADCAST_HTTP_403'],
    [{ status: 500 }, true, 'BROADCAST_SEND_UNCERTAIN'],
    [{ status: 200, data: {} }, true, 'BROADCAST_SEND_UNCERTAIN'],
    [{ status: 200, data: { message: { body: { mid: 123 } } } }, true, 'BROADCAST_SEND_UNCERTAIN'],
    [null, true, 'MAX_API_TIMEOUT'],
  ]) {
    const scope = createOperationScope(() => {});
    const send = createBroadcastSender('offline', { client: { call: async () => {
      if (!result) { const error = new Error('private text'); error.code = 'MAX_API_TIMEOUT'; throw error; }
      return result;
    } } });
    await assert.rejects(scope.run(() => send(update)), error => error.code === code);
    assert.equal(scope.ambiguousEffects.length > 0, ambiguous);
  }
});

test('ошибка broadcast consumer закрывает соединение и повторяется независимо от диалогов', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const connections = [];
  let attempts = 0;
  const processor = startBroadcastProcessor({ recoverExpired: async () => {}, publishable: async () => [] },
    { queue: 'fixture.events', url: 'amqp://offline:offline@rabbitmq' }, 'offline', {
      logger: { log() {}, warn() {}, error() {} },
      connect: async config => {
        assert.equal(config.prefetch, 1);
        const connection = { connected: true, close: async () => { connection.connected = false; },
          consume: async () => { if (++attempts === 1) throw new Error('offline failure'); }, cancel: async () => {},
        };
        connections.push(connection); return connection;
      },
    });
  t.after(() => processor.stop());
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  await flush();
  assert.equal(processor.snapshot().connected, false);
  assert.equal(connections.filter(connection => !connection.connected).length, 1);
  t.mock.timers.tick(1000); await flush();
  assert.equal(processor.snapshot().connected, true);
  await processor.stop();
  assert(connections.every(connection => !connection.connected));
});
