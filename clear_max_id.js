import mysql from 'mysql2/promise';
import 'dotenv/config';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
});

async function clearMaxIds() {
  const [result] = await pool.execute(
    'UPDATE glpi_users SET max_id = NULL WHERE max_id IS NOT NULL'
  );
  console.log('max_id очищен у ' + result.affectedRows + ' записей.');
  await pool.end();
}

clearMaxIds();