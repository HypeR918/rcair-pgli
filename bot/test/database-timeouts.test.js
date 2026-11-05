import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { setTimeout as delay } from 'node:timers/promises';
import { loadIsolated } from './helpers/isolated.mjs';
import * as operationContext from '../utils/operationContext.js';

const enabled = Boolean(process.env.RCAIR_TEST_DB_PORT);

async function fixture(t) {
  const config = { host: '127.0.0.1', port: Number(process.env.RCAIR_TEST_DB_PORT), user: 'root' };
  const admin = await mysql.createConnection(config);
  const database = `rcair_timeout_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.changeUser({ database });
  await admin.execute('CREATE TABLE effects (id INT PRIMARY KEY)');
  const db = await loadIsolated('services/dbService.js', {
    './utils/operationContext.js': operationContext,
    './config/env.js': { env: {
    BOT_DB_HOST: config.host, BOT_DB_PORT: config.port, BOT_DB_USER: 'root', BOT_DB_NAME: database,
    GLPI_DB_HOST: config.host, GLPI_DB_PORT: config.port, GLPI_DB_USER: 'root', GLPI_DB_NAME: database,
    DB_QUERY_TIMEOUT_MS: 80, DB_ACQUIRE_TIMEOUT_MS: 60,
  } } });
  t.after(async () => {
    await db.closeDb();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  });
  await db.botPool.execute('SELECT 1');
  return { pool: db.botPool, admin };
}

async function outcome(promise) {
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    delay(240).then(() => ({ pending: true })),
  ]);
}

test('MariaDB: зависший prepared execute закрывает соединение, следующий SQL работает', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const result = await outcome(f.pool.execute('SELECT SLEEP(?)', [0.5]));
  assert.equal(result.pending, undefined, 'SQL продолжает удерживать обработчик без ограничения времени');
  assert.equal(result.error?.code, 'DB_QUERY_TIMEOUT');
  const [rows] = await f.pool.execute('SELECT 1 AS value');
  assert.equal(rows[0].value, 1);
});

test('MariaDB: ожидание пула ограничено; SQL не выполняется после истечения ожидания', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const held = [];
  for (let i = 0; i < 10; i++) held.push(await f.pool.getConnection());
  const result = await outcome(f.pool.execute('INSERT INTO effects VALUES (?)', [1]));
  assert.equal(result.pending, undefined, 'Ожидание свободного соединения не ограничено');
  assert.equal(result.error?.code, 'DB_ACQUIRE_TIMEOUT');
  held.forEach(connection => connection.release());
  await delay(30);
  const [rows] = await f.admin.execute('SELECT COUNT(*) AS count FROM effects');
  assert.equal(rows[0].count, 0, 'Просроченный INSERT выполнился после освобождения соединения');
  assert.equal((await f.pool.execute('SELECT 1 AS value'))[0][0].value, 1);
});

test('MariaDB: после таймаута транзакции нельзя выполнить поздний commit', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const connection = await f.pool.getConnection();
  await connection.beginTransaction();
  await connection.execute('INSERT INTO effects VALUES (?)', [1]);
  const result = await outcome(connection.execute('SELECT SLEEP(?)', [0.5]));
  assert.equal(result.pending, undefined, 'Транзакция не завершилась по таймауту');
  assert.equal(result.error?.code, 'DB_QUERY_TIMEOUT');
  await assert.rejects(connection.commit(), error => error.code === 'DB_CONNECTION_CLOSED');
  connection.release();
  const [rows] = await f.admin.execute('SELECT COUNT(*) AS count FROM effects');
  assert.equal(rows[0].count, 0);
});

test('MariaDB: диагностика указывает этап SQL и сохраняет причину после таймаута', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const phases = [];
  const scope = operationContext.createOperationScope(phase => phases.push(phase));
  await assert.rejects(scope.run(() => f.pool.execute('SELECT SLEEP(?)', [0.5])),
    error => error.code === 'DB_QUERY_TIMEOUT');
  assert.ok(phases.includes('db.bot.acquire'));
  assert.ok(phases.includes('db.bot.execute'));
  assert.equal(scope.failedPhase, 'db.bot.execute');
});
