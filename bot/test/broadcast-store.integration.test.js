import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createDbPool } from '../services/dbPool.js';
import { createEventCodec } from '../queue/eventCodec.js';
import { createBroadcastStore } from '../broadcast/store.js';

const skip = !process.env.RCAIR_TEST_DB_PORT;
async function fixture(t, { legacy = false } = {}) {
  const config = { host: '127.0.0.1', port: Number(process.env.RCAIR_TEST_DB_PORT), user: 'root' };
  const admin = await mysql.createConnection(config);
  const database = `rcair_broadcast_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = createDbPool({ ...config, database, connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: true });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); });
  await pool.execute('CREATE TABLE bot_users (max_id BIGINT PRIMARY KEY, glpi_user_id INT NULL, is_blocked TINYINT NULL)');
  await pool.execute('CREATE TABLE blocked_max_ids (max_id BIGINT PRIMARY KEY)');
  await pool.execute('INSERT INTO bot_users VALUES (11,1,0),(12,2,0),(13,3,1),(14,4,0),(15,NULL,0),(16,0,0)');
  await pool.execute('INSERT INTO blocked_max_ids VALUES (14)');
  const codec = createEventCodec('a'.repeat(64));
  if (legacy) {
    await pool.execute(`CREATE TABLE bot_broadcast_jobs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      request_key BINARY(32) UNIQUE, request_hash BINARY(32), payload MEDIUMBLOB,
      created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB`);
    const key = codec.identify({ update_type: 'broadcast_key', key: 'legacy-notice-01' }).eventKey;
    const hash = codec.identify({ update_type: 'broadcast_text', text: 'Legacy текст' }).eventKey;
    await pool.execute('INSERT INTO bot_broadcast_jobs (request_key,request_hash,payload) VALUES (?,?,?)',
      [key, hash, codec.encode({ text: 'Legacy текст' }, key)]);
  }
  const store = createBroadcastStore(pool, codec);
  await store.ensureSchema(); await store.ensureSchema();
  return { store, pool };
}

test('snapshot зарегистрированных, конкурентная идемпотентность и шифрование текста', { skip }, async t => {
  const { store, pool } = await fixture(t);
  const results = await Promise.all([store.create('notice-001', 'private@example.invalid'), store.create('notice-001', 'private@example.invalid')]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results.filter(result => result.created).length, 1);
  const id = results[0].id;
  assert.equal((await store.status(id)).total, 2);
  await pool.execute('INSERT INTO bot_users VALUES (99,99,0)');
  assert.equal((await store.create('notice-001', 'private@example.invalid')).created, false);
  assert.equal((await store.status(id)).total, 2);
  await assert.rejects(store.create('notice-001', 'other'), error => error.code === 'BROADCAST_KEY_CONFLICT');
  const [rows] = await pool.execute('SELECT payload FROM bot_broadcast_jobs WHERE id = ?', [id]);
  assert(!rows[0].payload.includes(Buffer.from('private@example.invalid')));
  for (const event of await store.publishable()) {
    const claim = await store.claim(event.id, 'worker');
    assert.equal(claim.update.text, 'private@example.invalid');
    assert.equal(await store.markStarted(event.id, 'worker'), true);
    assert.equal(await store.complete(event.id, 'worker'), true);
  }
  await store.recoverExpired();
  assert.equal((await store.status(id)).counts.done, 2);
  assert.equal(await store.assertDrained(), true);
  const [done] = await pool.execute('SELECT payload FROM bot_broadcast_jobs WHERE id = ?', [id]);
  assert.equal(done[0].payload, null);
  assert.equal((await store.create('notice-001', 'private@example.invalid')).created, false);
});

test('блокировка после snapshot исключает отправку; crash после STARTED не повторяется', { skip }, async t => {
  const { store, pool } = await fixture(t);
  const job = await store.create('notice-002', 'Текст');
  const events = await store.publishable();
  await pool.execute('UPDATE bot_users SET is_blocked = 1 WHERE max_id = 11');
  assert.equal(await store.claim(events[0].id, 'worker'), null);
  await store.claim(events[1].id, 'worker');
  await store.markStarted(events[1].id, 'worker');
  await pool.execute('UPDATE bot_broadcast_deliveries SET lease_until = DATE_SUB(NOW(6), INTERVAL 1 SECOND) WHERE id = ?', [events[1].id]);
  await store.recoverExpired();
  assert.deepEqual(await store.publishable(), []);
  const status = await store.status(job.id);
  assert.equal(status.counts.skipped, 1);
  assert.equal(status.counts.uncertain, 1);
  assert.equal(await store.assertDrained(), false);
  assert.equal(await store.resolveProblem(events[1].id, 'skip'), true);
  assert.equal(await store.assertDrained(), true);
});

test('предстартовый lease восстанавливается; 429 повторяется с задержкой, 403 — нет', { skip }, async t => {
  const { store, pool } = await fixture(t);
  await store.create('notice-003', 'Текст');
  const [event] = await store.publishable();
  await store.claim(event.id, 'old');
  await pool.execute('UPDATE bot_broadcast_deliveries SET lease_until = DATE_SUB(NOW(6), INTERVAL 1 SECOND) WHERE id = ?', [event.id]);
  assert.equal(await store.markStarted(event.id, 'old'), false);
  await store.recoverExpired();
  await store.claim(event.id, 'new'); await store.markStarted(event.id, 'new');
  assert.equal(await store.retrySafe(event.id, 'new', 'BROADCAST_RATE_LIMIT'), 'pending');
  assert.equal(await store.claim(event.id, 'new'), null);
  await pool.execute('UPDATE bot_broadcast_deliveries SET next_attempt_at = NOW(6) WHERE id = ?', [event.id]);
  await store.claim(event.id, 'new'); await store.markStarted(event.id, 'new');
  assert.equal(await store.retrySafe(event.id, 'new', 'BROADCAST_HTTP_403'), 'failed');
  assert.equal(await store.claim(event.id, 'new'), null);
});

test('сбой snapshot откатывает задание целиком', { skip }, async t => {
  const { store, pool } = await fixture(t);
  await pool.execute("CREATE TRIGGER reject_delivery BEFORE INSERT ON bot_broadcast_deliveries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'offline failure'");
  await assert.rejects(store.create('notice-004', 'Текст'));
  const [rows] = await pool.execute('SELECT COUNT(*) AS amount FROM bot_broadcast_jobs');
  assert.equal(Number(rows[0].amount), 0);
});

test('пробная рассылка выбирает только указанный MAX ID; scope включён в идемпотентность', { skip }, async t => {
  const { store, pool } = await fixture(t);
  const job = await store.create('single-test-01', 'Проба', { audience: 'test', maxId: '12' });
  const status = await store.status(job.id);
  assert.equal(status.total, 1); assert.equal(status.audience, 'test');
  const [event] = await store.publishable();
  assert.equal((await store.claim(event.id, 'worker')).update.user.user_id, '12');
  assert.equal((await store.create('single-test-01', 'Проба', { audience: 'test', maxId: 12 })).created, false);
  await assert.rejects(store.create('single-test-01', 'Проба'), error => error.code === 'BROADCAST_KEY_CONFLICT');
  await assert.rejects(store.create('single-test-01', 'Проба', { audience: 'test', maxId: '11' }), error => error.code === 'BROADCAST_KEY_CONFLICT');
  for (const maxId of ['13', '14', '15', '99']) {
    await assert.rejects(store.create(`no-recipient-${maxId}`, 'Проба', { audience: 'test', maxId }),
      error => error.code === 'BROADCAST_RECIPIENT_NOT_FOUND');
  }
  await assert.rejects(store.create('missing-id-01', 'Проба', { audience: 'test' }), error => error.code === 'BROADCAST_INVALID_RECIPIENT');
  const [jobs] = await pool.execute('SELECT COUNT(*) AS amount FROM bot_broadcast_jobs');
  assert.equal(Number(jobs[0].amount), 1, 'Невалидные тесты не создают заданий');
});

test('обновление старой схемы сохраняет idempotency и аудиторию прежних рассылок', { skip }, async t => {
  const { store } = await fixture(t, { legacy: true });
  const old = await store.create('legacy-notice-01', 'Legacy текст');
  assert.equal(old.created, false);
  assert.equal((await store.status(old.id)).audience, 'all');
  await assert.rejects(store.create('legacy-notice-01', 'Legacy текст', { audience: 'test', maxId: '12' }),
    error => error.code === 'BROADCAST_KEY_CONFLICT');
});
