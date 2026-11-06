import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createDbPool } from '../services/dbPool.js';
import { createEventCodec } from '../queue/eventCodec.js';
import { createEventStore } from '../queue/eventStore.js';
import { connectRabbit } from '../queue/rabbit.js';
import { startEventRelay } from '../queue/relay.js';
import { startEventWorker } from '../queue/worker.js';
import { createWebhookBot } from '../transport/webhookBot.js';
import { startMaxTransport } from '../transport/maxTransport.js';
import { recordAmbiguousEffect } from '../utils/operationContext.js';

const skip = !process.env.RCAIR_TEST_DB_PORT || !process.env.RCAIR_TEST_RABBIT_PORT;
const message = (mid, user = 123) => ({ update_type: 'message_created', timestamp: 1,
  message: { sender: { user_id: user }, recipient: { chat_id: user }, body: { mid, text: '/start' } } });
const quiet = { log() {}, warn() {}, error() {} };

async function waitFor(action) {
  const until = Date.now() + 8000;
  while (Date.now() < until) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Тестовое условие не выполнено');
}

async function fixture(t, handler) {
  const base = { host: '127.0.0.1', port: Number(process.env.RCAIR_TEST_DB_PORT), user: 'root' };
  const admin = await mysql.createConnection(base);
  const database = `rcair_rabbit_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = createDbPool({ ...base, database, connectionLimit: 8 });
  const store = createEventStore(pool, { codec: createEventCodec('a'.repeat(64)), republishMs: 150, retryBaseMs: 25 });
  await store.ensureSchema();
  const config = { url: `amqp://rcair-test:offline-test@127.0.0.1:${process.env.RCAIR_TEST_RABBIT_PORT}`,
    queue: `test.${database}`, prefetch: 4 };
  const rabbit = await connectRabbit(config);
  const worker = await startEventWorker(store, rabbit, handler, { logger: quiet, heartbeatMs: 50 });
  let relay;
  t.after(async () => {
    await relay?.stop(); await worker.stop();
    const cleanup = await connectRabbit(config); await cleanup.close();
    await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end();
  });
  return { store, rabbit, config, startRelay() { relay = startEventRelay(store, config, { intervalMs: 25, logger: quiet }); return relay; } };
}

test('HTTP200 после INSERT без Rabbit: дальнейшая доставка и дубликат ID не выполняют handler повторно', { skip }, async t => {
  let handled = 0;
  const f = await fixture(t, async () => { handled++; });
  const bot = createWebhookBot('offline-token');
  bot.on('message_created', () => { throw new Error('HTTP listener не должен запускать бизнес-handler'); });
  const transport = await startMaxTransport(bot, {
    BOT_TOKEN: 'offline-token', PORT: 3000, WEBHOOK_URL: 'https://example.test/max/callback/', WEBHOOK_SECRET: 'offline-secret',
  }, { acceptUpdate: f.store.accept, existingSubscription: true,
    api: async () => { throw new Error('Недоступный исходящий MAX API не должен мешать приёму'); },
    logger: quiet, port: 0, host: '127.0.0.1' });
  t.after(() => transport.stop());
  const url = `http://127.0.0.1:${transport.server.address().port}/max/callback/`;
  const deliver = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Max-Bot-Api-Secret': 'offline-secret' }, body: JSON.stringify(message('one')) });
  assert.equal((await deliver()).status, 200);
  assert.equal((await deliver()).status, 200);
  assert.equal(handled, 0);
  assert.equal((await f.store.stats()).states.pending, 1);
  f.startRelay();
  await waitFor(async () => (await f.store.stats()).states.done === 1);
  await f.rabbit.publish('1'); await f.rabbit.publish('1');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(handled, 1);
});

test('prefetch4: порядок одного пользователя сохраняется, другой пользователь не ждёт зависший handler', { skip }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const completed = [];
  let entered = false;
  const f = await fixture(t, async update => {
    const mid = update.message.body.mid;
    if (mid === 'one') { entered = true; await gate; }
    completed.push(mid);
  });
  await f.store.accept(message('one')); f.startRelay();
  await waitFor(() => entered);
  await f.store.accept(message('two'));
  await f.store.accept(message('other', 456));
  await waitFor(() => completed.includes('other'));
  assert(!completed.includes('two'));
  release();
  await waitFor(async () => (await f.store.stats()).states.done === 3);
  assert.deepEqual(completed, ['other', 'one', 'two']);
});

test('неясный GLPI POST остаётся UNCERTAIN даже если controller поймал исключение; второй consumer отклоняется', { skip }, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; if (calls === 1) recordAmbiguousEffect('glpi.write'); });
  const second = await connectRabbit(f.config);
  await assert.rejects(second.consume(() => {}));
  await second.close();
  await f.store.accept(message('uncertain')); f.startRelay();
  await waitFor(async () => (await f.store.stats()).states.uncertain === 1);
  const after = await f.store.accept(message('next'));
  assert(!(await f.store.publishable()).some(row => row.id === after.id));
  const [problem] = await f.store.problems();
  await f.store.resolveProblem(problem.id, 'retry');
  await waitFor(async () => (await f.store.stats()).states.done === 2);
  assert.equal(calls, 3, 'Ручной retry должен выполнить исходное событие, затем следующее');
});

test('безопасный /start после временного сбоя повторяется, порядок следующего события сохраняется', { skip }, async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) { const error = new Error('offline timeout'); error.code = 'MAX_API_TIMEOUT'; throw error; }
  });
  await f.store.accept(message('retry.start'));
  await f.store.accept(message('after.start'));
  f.startRelay();
  await waitFor(async () => (await f.store.stats()).states.done === 2);
  assert.equal(calls, 3);
});
