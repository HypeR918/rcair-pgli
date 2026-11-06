import test from 'node:test';
import assert from 'node:assert/strict';
import { startEventRelay } from '../queue/relay.js';
import { readQueueConfig } from '../queue/config.js';

const values = { RABBITMQ_URL: 'amqp://fixture:offline@rabbitmq', EVENT_PAYLOAD_SECRET: 'a'.repeat(64) };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('relay подхватывает новое событие за 200 мс; восстановление lease не учащается', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  let available = false;
  let recovered = 0;
  const published = [];
  const store = {
    recoverExpired: async () => { recovered++; },
    publishable: async () => available ? [{ id: '1', attempts: 0 }] : [],
    markPublished: async () => { available = false; },
  };
  const relay = startEventRelay(store, readQueueConfig(values), { connect: async () => ({
    connected: true, publish: async id => published.push(id), close: async () => {},
  }) });
  t.after(() => relay.stop());
  await flush();
  available = true;
  t.mock.timers.tick(199); await flush();
  assert.deepEqual(published, []);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(published, ['1']);
  assert.equal(recovered, 1);
  t.mock.timers.tick(800); await flush();
  assert.equal(recovered, 2);
  assert.equal(relay.snapshot().interval_ms, 200);
});

test('частые ticks не создают параллельные публикации; stop ждёт publisher confirm', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  let release;
  const confirm = new Promise(resolve => { release = resolve; });
  let publications = 0;
  let closed = false;
  const relay = startEventRelay({ recoverExpired: async () => {},
    publishable: async () => [{ id: '1' }], markPublished: async () => {},
  }, readQueueConfig(values), { connect: async () => ({ connected: true,
    publish: async () => { publications++; await confirm; },
    close: async () => { closed = true; },
  }) });
  t.after(async () => { release(); await relay.stop(); });
  await flush();
  t.mock.timers.tick(2000); await flush();
  assert.equal(publications, 1);
  const stopping = relay.stop();
  await flush();
  assert.equal(closed, false);
  release(); await stopping;
  t.mock.timers.tick(2000); await flush();
  assert.equal(closed, true);
  assert.equal(publications, 1);
});

test('интервал relay настраивается и ограничен, чтобы исключить busy loop', () => {
  assert.equal(readQueueConfig(values).relayIntervalMs, 200);
  assert.equal(readQueueConfig({ ...values, EVENT_RELAY_INTERVAL_MS: '1000' }).relayIntervalMs, 1000);
  for (const invalid of ['', '0', '99', '5001', 'NaN', '200.5']) {
    assert.throws(() => readQueueConfig({ ...values, EVENT_RELAY_INTERVAL_MS: invalid }), /EVENT_RELAY_INTERVAL_MS/);
  }
});
