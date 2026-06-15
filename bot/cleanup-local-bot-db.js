import mysql from 'mysql2/promise';
import 'dotenv/config';

const CONFIRM_ARG = '--yes';

function requireConfirm() {
  if (!process.argv.includes(CONFIRM_ARG)) {
    console.log('');
    console.log('Этот скрипт очистит локальные данные бота:');
    console.log('- таблицу sds_requests');
    console.log('- таблицу blocked_max_ids');
    console.log('- поля glpi_users.max_id и glpi_users.is_blocked');
    console.log('');
    console.log('Он НЕ удаляет пользователей GLPI и НЕ удаляет заявки GLPI.');
    console.log('');
    console.log(`Для запуска используй: node cleanup-local-bot-db.js ${CONFIRM_ARG}`);
    console.log('');
    process.exit(1);
  }
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = ?
    LIMIT 1
    `,
    [tableName]
  );

  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND column_name = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );

  return rows.length > 0;
}

async function main() {
  requireConfirm();

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });

  try {
    console.log('Подключение к базе выполнено.');
    console.log('База:', process.env.DB_NAME);

    await connection.beginTransaction();

    if (await tableExists(connection, 'sds_requests')) {
      await connection.execute('DELETE FROM sds_requests');
      await connection.execute('ALTER TABLE sds_requests AUTO_INCREMENT = 1');
      console.log('Очищена таблица sds_requests.');
    } else {
      console.log('Таблица sds_requests не найдена, пропускаю.');
    }

    if (await tableExists(connection, 'blocked_max_ids')) {
      await connection.execute('DELETE FROM blocked_max_ids');
      console.log('Очищена таблица blocked_max_ids.');
    } else {
      console.log('Таблица blocked_max_ids не найдена, пропускаю.');
    }

    const hasMaxId = await columnExists(connection, 'glpi_users', 'max_id');
    const hasIsBlocked = await columnExists(connection, 'glpi_users', 'is_blocked');

    if (hasMaxId && hasIsBlocked) {
      await connection.execute(
        'UPDATE glpi_users SET max_id = NULL, is_blocked = 0 WHERE max_id IS NOT NULL OR is_blocked <> 0'
      );
      console.log('Очищены поля glpi_users.max_id и glpi_users.is_blocked.');
    } else if (hasMaxId) {
      await connection.execute(
        'UPDATE glpi_users SET max_id = NULL WHERE max_id IS NOT NULL'
      );
      console.log('Очищено поле glpi_users.max_id.');
    } else if (hasIsBlocked) {
      await connection.execute(
        'UPDATE glpi_users SET is_blocked = 0 WHERE is_blocked <> 0'
      );
      console.log('Очищено поле glpi_users.is_blocked.');
    } else {
      console.log('Поля glpi_users.max_id и glpi_users.is_blocked не найдены, пропускаю.');
    }

    await connection.commit();

    console.log('');
    console.log('Очистка завершена успешно.');
  } catch (err) {
    await connection.rollback();

    console.error('');
    console.error('Ошибка очистки. Изменения отменены.');
    console.error(err);

    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}

main();