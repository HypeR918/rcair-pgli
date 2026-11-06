import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createDbPool } from '../services/dbPool.js';
import { createEventCodec } from '../queue/eventCodec.js';
import { createEventStore } from '../queue/eventStore.js';

const message = (mid, user = 123) => ({ update_type: 'message_created', timestamp: 1,
  message: { sender: { user_id: user }, body: { mid, text: '123456 private@example.invalid' } } });

async function fixture(t, options = {}) {
  const config = { host: '127.0.0.1', port: Number(process.env.RCAIR_TEST_DB_PORT), user: 'root' };
  const admin = await mysql.createConnection(config);
  const database = `rcair_events_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = createDbPool({ ...config, database, connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
  const codec = createEventCodec('a'.repeat(64));
  const store = createEventStore(pool, { codec, ...options });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); });
  await store.ensureSchema(); await store.ensureSchema();
  return { store, pool, codec };
}

test('время очереди считается часами SQL-сервера, без преобразования DATETIME в Node',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool } = await fixture(t);
    const event = await store.accept(message('timed'));
    await pool.execute('UPDATE bot_max_events SET created_at = DATE_SUB(NOW(6), INTERVAL 2 SECOND) WHERE id = ?', [event.id]);
    const claimed = await store.claim(event.id, 'worker');
    assert(Number.isInteger(claimed.queueWaitMs));
    assert(claimed.queueWaitMs >= 2000 && claimed.queueWaitMs < 10000);
  });

test('inbox: повтор/порядок пользователя, разные пользователи, очистка DONE и сохранённая дедупликация',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool } = await fixture(t);
    const [first, duplicate] = await Promise.all([store.accept(message('one')), store.accept(message('one'))]);
    assert.equal(first.id, duplicate.id);
    assert.equal([first, duplicate].filter(row => row.duplicate).length, 1);
    const next = await store.accept(message('two'));
    const other = await store.accept(message('other', 456));
    assert.deepEqual((await store.publishable()).map(row => row.id), [first.id, other.id]);
    assert.equal(await store.claim(next.id, 'worker'), null);
    const claim = await store.claim(first.id, 'worker');
    assert.equal(claim.update.message.body.mid, 'one');
    assert.equal(await store.markStarted(first.id, 'wrong'), false);
    assert.equal(await store.markStarted(first.id, 'worker'), true);
    assert.equal(await store.claim(first.id, 'another'), null);
    assert.equal(await store.complete(first.id, 'worker'), true);
    assert((await store.publishable()).some(row => row.id === next.id));
    const [rows] = await pool.execute('SELECT payload FROM bot_max_events WHERE id = ?', [first.id]);
    assert.equal(rows[0].payload, null);
    assert.equal((await store.accept(message('one'))).duplicate, true);
    assert.equal((await store.stats()).states.done, 1);
  });

test('lease: до STARTED безопасное восстановление; после STARTED — UNCERTAIN без автоматического повтора',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool } = await fixture(t);
    const before = await store.accept(message('before'));
    await store.claim(before.id, 'old');
    await pool.execute('UPDATE bot_max_events SET lease_until = DATE_SUB(NOW(6), INTERVAL 1 SECOND) WHERE id = ?', [before.id]);
    assert.equal(await store.markStarted(before.id, 'old'), false);
    await store.recoverExpired();
    assert(await store.claim(before.id, 'new'));
    assert.equal(await store.markStarted(before.id, 'new'), true);
    await pool.execute('UPDATE bot_max_events SET lease_until = DATE_SUB(NOW(6), INTERVAL 1 SECOND) WHERE id = ?', [before.id]);
    await store.recoverExpired();
    assert.equal(await store.claim(before.id, 'newer'), null);
    assert.equal((await store.stats()).states.uncertain, 1);
    assert.equal(await store.complete(before.id, 'new'), false);
    const next = await store.accept(message('after'));
    assert(!(await store.publishable()).some(row => row.id === next.id));
    await store.resolveProblem(before.id, 'skip');
    assert((await store.publishable()).some(row => row.id === next.id));
  });

test('публикация повторяется после потери брокера, failed требует явного разрешения, payload не раскрывается',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool } = await fixture(t);
    const event = await store.accept(message('secret.failed.mid'));
    await store.markPublished(event.id);
    assert.equal((await store.publishable()).length, 0);
    await pool.execute('UPDATE bot_max_events SET published_at = DATE_SUB(NOW(6), INTERVAL 1 MINUTE) WHERE id = ?', [event.id]);
    assert.equal((await store.publishable()).length, 1);
    await store.claim(event.id, 'worker'); await store.markStarted(event.id, 'worker');
    await store.fail(event.id, 'worker', 'MAX_API_TIMEOUT');
    assert.equal((await store.publishable()).length, 0);
    assert.equal((await store.stats()).states.failed, 1);
    const output = JSON.stringify(await store.problems());
    for (const privateValue of ['123456', 'private@example.invalid', 'secret.failed.mid']) assert(!output.includes(privateValue));
    await store.resolveProblem(event.id, 'retry');
    assert.equal((await store.publishable()).length, 1);
  });

test('два producer: поздний INSERT одного пользователя не обгоняет ещё не закоммиченный ранний',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool, codec } = await fixture(t);
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const committing = new Promise(resolve => { entered = resolve; });
    const slow = createEventStore({ ...pool, async getConnection() {
      const connection = await pool.getConnection();
      return { ...connection, async commit() { entered(); await gate; return connection.commit(); } };
    } }, { codec });
    const first = slow.accept(message('slow.first'));
    await committing;
    let secondDone = false;
    const second = store.accept(message('fast.second')).then(row => { secondDone = true; return row; });
    try {
      const other = await store.accept(message('other.user', 456));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(secondDone, false);
      assert.deepEqual((await store.publishable()).map(row => row.id), [other.id]);
    } finally { release(); await Promise.all([first, second]); }
    const a = await first;
    const b = await second;
    assert(BigInt(a.id) < BigInt(b.id));
  });

test('drain проверяет актуальные INSERT, а не пустой snapshot перед чужим COMMIT',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async t => {
    const { store, pool, codec } = await fixture(t);
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const committing = new Promise(resolve => { entered = resolve; });
    const slow = createEventStore({ ...pool, async getConnection() {
      const connection = await pool.getConnection();
      return { ...connection, async commit() { entered(); await gate; return connection.commit(); } };
    } }, { codec });
    const inserting = slow.accept(message('commit.in.progress'));
    await committing;
    let finished = false;
    const checking = store.assertDrained().then(value => { finished = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(finished, false, 'drain должен дождаться существующего INSERT');
    } finally { release(); await inserting; }
    assert.equal(await checking, false);
  });
