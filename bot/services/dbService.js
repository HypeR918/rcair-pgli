import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { normalizeEmail, textHash } from '../utils/textUtils.js';

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
});

export async function ensureDatabaseSchema() {
  const queries = [
    'ALTER TABLE glpi_users ADD COLUMN max_id BIGINT DEFAULT NULL',
    'ALTER TABLE glpi_users ADD COLUMN is_blocked TINYINT(1) DEFAULT 0',

    `CREATE TABLE IF NOT EXISTS blocked_max_ids (
      max_id BIGINT PRIMARY KEY,
      blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS sds_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      max_id BIGINT NOT NULL,
      email VARCHAR(255) NOT NULL,
      org VARCHAR(255),
      dept VARCHAR(255),
      fio VARCHAR(255),
      position VARCHAR(255),
      phone VARCHAR(255),
      issue TEXT,
      glpi_ticket_id INT DEFAULT NULL,
      glpi_ticket_status INT DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'PENDING',
      decision_text TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME DEFAULT NULL
    )`,

    'ALTER TABLE sds_requests ADD COLUMN glpi_ticket_id INT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN glpi_ticket_status INT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN decision_text TEXT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN decided_at DATETIME DEFAULT NULL',

    `CREATE TABLE IF NOT EXISTS bot_user_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      max_id BIGINT NOT NULL,
      glpi_user_id INT NOT NULL,
      glpi_ticket_id INT NOT NULL,
      title VARCHAR(255),
      status INT DEFAULT NULL,
      solution_notified TINYINT(1) DEFAULT 0,
      closed_notified TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_glpi_ticket_id (glpi_ticket_id)
    )`,

    `CREATE TABLE IF NOT EXISTS bot_ticket_followups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      glpi_ticket_id INT NOT NULL,
      glpi_followup_id INT NOT NULL,
      content_hash CHAR(64) DEFAULT NULL,
      sent_to_max TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ticket_followup (glpi_ticket_id, glpi_followup_id)
    )`,

    `CREATE TABLE IF NOT EXISTS bot_ticket_ratings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      max_id BIGINT NOT NULL,
      glpi_ticket_id INT NOT NULL,
      rating TINYINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ticket_rating (glpi_ticket_id)
    )`,

    'ALTER TABLE bot_user_tickets ADD COLUMN solution_notified TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_user_tickets ADD COLUMN closed_notified TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_ticket_followups ADD COLUMN content_hash CHAR(64) DEFAULT NULL',
  ];

  for (const sql of queries) {
    try {
      await pool.execute(sql);
    } catch (err) {
      if (
        err.code !== 'ER_DUP_FIELDNAME' &&
        err.code !== 'ER_TABLE_EXISTS_ERROR' &&
        err.code !== 'ER_DUP_KEYNAME'
      ) {
        console.error('DB schema error:', err.message);
      }
    }
  }
}

export async function closeDb() {
  await pool.end();
}

export async function isMaxIdBlocked(maxUserId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM blocked_max_ids WHERE max_id = ? LIMIT 1',
    [maxUserId]
  );

  return rows.length > 0;
}

export async function blockMaxId(maxUserId) {
  await pool.execute(
    `INSERT INTO blocked_max_ids (max_id, blocked_at)
     VALUES (?, NOW())
     ON DUPLICATE KEY UPDATE blocked_at = NOW()`,
    [maxUserId]
  );

  await pool.execute(
    'UPDATE glpi_users SET is_blocked = 1 WHERE max_id = ?',
    [maxUserId]
  );
}

export async function unblockMaxId(maxUserId) {
  await pool.execute(
    'DELETE FROM blocked_max_ids WHERE max_id = ?',
    [maxUserId]
  );

  await pool.execute(
    'UPDATE glpi_users SET is_blocked = 0 WHERE max_id = ?',
    [maxUserId]
  );
}

export async function findGlpiUserByMaxId(maxUserId) {
  const [rows] = await pool.execute(
    `SELECT id, name, realname, firstname, entities_id AS entity_id
     FROM glpi_users
     WHERE max_id = ?
       AND is_active = 1
       AND COALESCE(is_blocked, 0) = 0
     LIMIT 1`,
    [maxUserId]
  );

  return rows[0] || null;
}

export async function findGlpiUserAfterSdsImport(email) {
  const normalizedEmail = normalizeEmail(email);

  const [rows] = await pool.execute(
    `SELECT
       u.id,
       u.name,
       u.realname,
       u.firstname,
       u.entities_id AS entity_id
     FROM glpi_users u
     INNER JOIN glpi_useremails e ON e.users_id = u.id
     WHERE LOWER(e.email) = ?
       AND u.is_active = 1
     ORDER BY u.id DESC
     LIMIT 1`,
    [normalizedEmail]
  );

  return rows[0] || null;
}

export async function linkMaxIdToGlpiUser(glpiUserId, maxUserId) {
  await pool.execute(
    `UPDATE glpi_users
     SET max_id = ?, is_blocked = 0, is_active = 1
     WHERE id = ?`,
    [maxUserId, glpiUserId]
  );
}

export async function createSdsRequest(maxUserId, email, data) {
  const [result] = await pool.execute(
    `INSERT INTO sds_requests
      (max_id, email, org, dept, fio, position, phone, issue, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      maxUserId,
      email,
      data.org,
      data.dept,
      data.fio,
      data.position,
      data.phone,
      data.issue,
    ]
  );

  return result.insertId;
}

export async function updateSdsRequestGlpiTicketId(requestId, glpiTicketId) {
  await pool.execute(
    `UPDATE sds_requests
     SET glpi_ticket_id = ?
     WHERE id = ?`,
    [glpiTicketId, requestId]
  );
}

export async function getPendingSdsRequests(limit = 20) {
  const [rows] = await pool.execute(
    `SELECT id, max_id, email, glpi_ticket_id
     FROM sds_requests
     WHERE status = 'PENDING'
       AND glpi_ticket_id IS NOT NULL
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  return rows;
}

export async function updateSdsRequestTicketStatus(requestId, ticketStatus) {
  await pool.execute(
    `UPDATE sds_requests
     SET glpi_ticket_status = ?
     WHERE id = ?`,
    [ticketStatus || null, requestId]
  );
}

export async function approveSdsRequest(requestId, decisionText, ticketStatus) {
  await pool.execute(
    `UPDATE sds_requests
     SET status = 'APPROVED',
         decision_text = ?,
         glpi_ticket_status = ?,
         decided_at = NOW()
     WHERE id = ?`,
    [decisionText || 'Заявка подтверждена', ticketStatus || null, requestId]
  );
}

export async function rejectSdsRequest(requestId, decisionText, ticketStatus) {
  await pool.execute(
    `UPDATE sds_requests
     SET status = 'REJECTED',
         decision_text = ?,
         glpi_ticket_status = ?,
         decided_at = NOW()
     WHERE id = ?`,
    [decisionText || 'Заявка отклонена', ticketStatus || null, requestId]
  );
}

export async function saveBotUserTicket(maxUserId, glpiUserId, ticketId, title, status = 1) {
  await pool.execute(
    `INSERT INTO bot_user_tickets
      (max_id, glpi_user_id, glpi_ticket_id, title, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      max_id = VALUES(max_id),
      glpi_user_id = VALUES(glpi_user_id),
      title = VALUES(title),
      status = VALUES(status),
      updated_at = NOW()`,
    [maxUserId, glpiUserId, ticketId, title, status]
  );
}

export async function getBotUserTicket(maxUserId, ticketId) {
  const [rows] = await pool.execute(
    `SELECT id, max_id, glpi_user_id, glpi_ticket_id, title, status, solution_notified, closed_notified
     FROM bot_user_tickets
     WHERE max_id = ?
       AND glpi_ticket_id = ?
     LIMIT 1`,
    [maxUserId, ticketId]
  );

  return rows[0] || null;
}

export async function getBotUserTickets(maxUserId, limit = 10) {
  const [rows] = await pool.execute(
    `SELECT id, max_id, glpi_user_id, glpi_ticket_id, title, status, solution_notified, closed_notified
     FROM bot_user_tickets
     WHERE max_id = ?
     ORDER BY glpi_ticket_id DESC
     LIMIT ?`,
    [maxUserId, limit]
  );

  return rows;
}

export async function getActiveBotUserTickets(limit = 50) {
  const [rows] = await pool.execute(
    `SELECT id, max_id, glpi_user_id, glpi_ticket_id, title, status, solution_notified, closed_notified
     FROM bot_user_tickets
     WHERE status IS NULL OR status < 6
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  return rows;
}

export async function updateBotUserTicketStatus(ticketId, status, title = null) {
  if (title) {
    await pool.execute(
      `UPDATE bot_user_tickets
       SET status = ?, title = ?
       WHERE glpi_ticket_id = ?`,
      [status, title, ticketId]
    );
    return;
  }

  await pool.execute(
    `UPDATE bot_user_tickets
     SET status = ?
     WHERE glpi_ticket_id = ?`,
    [status, ticketId]
  );
}

export async function markTicketSolutionNotified(ticketId) {
  await pool.execute(
    `UPDATE bot_user_tickets
     SET solution_notified = 1
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function resetTicketSolutionNotified(ticketId) {
  await pool.execute(
    `UPDATE bot_user_tickets
     SET solution_notified = 0
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function markTicketClosedNotified(ticketId) {
  await pool.execute(
    `UPDATE bot_user_tickets
     SET closed_notified = 1
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function markFollowupAsKnown(ticketId, followupId, content, sentToMax) {
  await pool.execute(
    `INSERT INTO bot_ticket_followups
      (glpi_ticket_id, glpi_followup_id, content_hash, sent_to_max)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      content_hash = VALUES(content_hash),
      sent_to_max = GREATEST(sent_to_max, VALUES(sent_to_max))`,
    [ticketId, followupId, textHash(content), sentToMax ? 1 : 0]
  );
}

export async function isFollowupKnown(ticketId, followupId) {
  const [rows] = await pool.execute(
    `SELECT 1
     FROM bot_ticket_followups
     WHERE glpi_ticket_id = ?
       AND glpi_followup_id = ?
     LIMIT 1`,
    [ticketId, followupId]
  );

  return rows.length > 0;
}

export async function deleteBotUserTicketByTicketId(ticketId) {
  const normalizedTicketId = Number(ticketId || 0);

  if (!normalizedTicketId) {
    return;
  }

  await pool.execute(
    'DELETE FROM bot_ticket_followups WHERE glpi_ticket_id = ?',
    [normalizedTicketId]
  );

  await pool.execute(
    'DELETE FROM bot_user_tickets WHERE glpi_ticket_id = ?',
    [normalizedTicketId]
  );
}

export async function getBotTicketRating(ticketId) {
  const normalizedTicketId = Number(ticketId || 0);

  if (!normalizedTicketId) {
    return null;
  }

  const [rows] = await pool.execute(
    `SELECT id, max_id, glpi_ticket_id, rating, created_at
     FROM bot_ticket_ratings
     WHERE glpi_ticket_id = ?
     LIMIT 1`,
    [normalizedTicketId]
  );

  return rows[0] || null;
}

export async function saveBotTicketRating(maxUserId, ticketId, rating) {
  const normalizedMaxUserId = Number(maxUserId || 0);
  const normalizedTicketId = Number(ticketId || 0);
  const normalizedRating = Number(rating || 0);

  if (!normalizedMaxUserId) {
    throw new Error(`Некорректный MAX ID: ${maxUserId}`);
  }

  if (!normalizedTicketId) {
    throw new Error(`Некорректный номер заявки: ${ticketId}`);
  }

  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    throw new Error(`Некорректная оценка: ${rating}`);
  }

  const [result] = await pool.execute(
    `INSERT IGNORE INTO bot_ticket_ratings
      (max_id, glpi_ticket_id, rating)
     VALUES (?, ?, ?)`,
    [normalizedMaxUserId, normalizedTicketId, normalizedRating]
  );

  return result.affectedRows === 1;
}

export async function forceTicketRequesterInDb(ticketId, glpiUserId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `UPDATE glpi_tickets
       SET users_id_recipient = ?,
           date_mod = NOW()
       WHERE id = ?`,
      [glpiUserId, ticketId]
    );

    await connection.execute(
      `DELETE FROM glpi_tickets_users
       WHERE tickets_id = ?
         AND type = 1`,
      [ticketId]
    );

    await connection.execute(
      `INSERT INTO glpi_tickets_users
        (tickets_id, users_id, type, use_notification, alternative_email)
       VALUES (?, ?, 1, 1, NULL)`,
      [ticketId, glpiUserId]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('forceTicketRequesterInDb error:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}