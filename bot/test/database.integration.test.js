import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { loadIsolated } from './helpers/isolated.mjs';

test('MariaDB: миграции повторяемы, блокировка атомарна, права актуальны, лимиты переживают новую загрузку',
  { skip: !process.env.RCAIR_TEST_DB_PORT }, async () => {
    // Только специально созданная тестовая БД; рабочие BOT_DB_*/GLPI_DB_* не используются.
    const config = { host: '127.0.0.1', port: Number(process.env.RCAIR_TEST_DB_PORT), user: 'root' };
    const connection = await mysql.createConnection(config);
    const database = `rcair_test_${process.pid}_${Date.now()}`;
    await connection.query(`CREATE DATABASE ${database}`);
    await connection.changeUser({ database });
    const env = { BOT_DB_HOST: config.host, BOT_DB_PORT: config.port, BOT_DB_USER: config.user, BOT_DB_NAME: database,
      GLPI_DB_HOST: config.host, GLPI_DB_PORT: config.port, GLPI_DB_USER: config.user, GLPI_DB_NAME: database };
    const db = await loadIsolated('services/dbService.js', { './config/env.js': { env } });
    let reloaded;
    try {
      await connection.execute('CREATE TABLE glpi_users (id INT PRIMARY KEY, name VARCHAR(255), realname VARCHAR(255), firstname VARCHAR(255), entities_id INT, is_active INT, is_deleted INT)');
      await connection.execute('CREATE TABLE glpi_useremails (id INT PRIMARY KEY, users_id INT, email VARCHAR(255), is_default INT)');
      await connection.execute('CREATE TABLE glpi_tickets (id INT PRIMARY KEY, is_deleted INT)');
      await connection.execute('CREATE TABLE glpi_tickets_users (tickets_id INT, users_id INT, type INT)');
      await db.ensureDatabaseSchema(); await db.ensureDatabaseSchema();
      await connection.execute("INSERT INTO glpi_users (id, name, is_active, is_deleted) VALUES (42, 'fixture', 1, 0)");
      await connection.execute("INSERT INTO glpi_useremails VALUES (1, 42, 'fixture@example.test', 1)");
      await connection.execute('INSERT INTO glpi_tickets VALUES (7, 0)');
      await connection.execute('INSERT INTO glpi_tickets_users VALUES (7, 42, 1)');
      await db.linkMaxIdToGlpiUser(42, 101, 'fixture@example.test');
      assert.equal((await db.getAuthorizedTicketUser(101, 7)).id, 42);
      await db.blockMaxId(101); assert.equal(await db.isMaxIdBlocked(101), true);
      assert.equal(await db.getAuthorizedTicketUser(101, 7), null);
      await db.unblockMaxId(101); assert.equal(await db.isMaxIdBlocked(101), false);
      assert.equal((await db.getAuthorizedTicketUser(101, 7)).id, 42);
      await connection.execute('UPDATE glpi_users SET is_blocked = 1 WHERE id = 42');
      assert.equal(await db.getAuthorizedTicketUser(101, 7), null);
      await connection.execute('UPDATE glpi_users SET is_blocked = 0 WHERE id = 42');
      await connection.execute('DELETE FROM glpi_tickets_users');
      assert.equal(await db.getAuthorizedTicketUser(101, 7), null);
      await connection.execute("CREATE TRIGGER fail_block BEFORE UPDATE ON bot_users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture failure'");
      await assert.rejects(db.blockMaxId(101), /fixture failure/);
      assert.equal(await db.isMaxIdBlocked(101), false);
      await connection.execute('DROP TRIGGER fail_block');
      await db.blockMaxId(101);
      await connection.execute("CREATE TRIGGER fail_unblock BEFORE UPDATE ON bot_users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture unblock failure'");
      await assert.rejects(db.unblockMaxId(101), /fixture unblock failure/);
      const [stillBlocked] = await connection.execute('SELECT 1 FROM blocked_max_ids WHERE max_id = 101');
      assert.equal(stillBlocked.length, 1);
      await connection.execute('DROP TRIGGER fail_unblock');
      await db.unblockMaxId(101);
      assert.equal(await db.reserveVerificationSend(101, 'fixture@example.test', 60000), 0);
      reloaded = await loadIsolated('services/dbService.js', { './config/env.js': { env } });
      assert((await reloaded.reserveVerificationSend(101, 'different@example.test', 60000)) > 0);
      assert((await reloaded.reserveVerificationSend(102, 'fixture@example.test', 60000)) > 0);
      const results = await Promise.all([201, 202].map(id => db.reserveVerificationSend(id, 'shared@example.test', 60000)));
      assert.equal(results.filter(ms => ms === 0).length, 1);
      for (let id = 1; id <= 45; id++) await connection.execute(
        "INSERT INTO sds_requests (max_id, email, glpi_ticket_id) VALUES (?, 'fixture@example.test', ?)", [id, id]);
      const first = await db.getPendingSdsRequests(20);
      const second = await db.getPendingSdsRequests(20, first.at(-1).id, first[0].polling_max_id);
      const third = await db.getPendingSdsRequests(20, second.at(-1).id, first[0].polling_max_id);
      assert.equal(first.length + second.length + third.length, 45);
    } finally {
      await Promise.all([db.closeDb(), reloaded?.closeDb()]);
      await connection.query(`DROP DATABASE ${database}`);
      await connection.end();
    }
  });
