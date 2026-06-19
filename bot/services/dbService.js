import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { normalizeEmail, textHash } from '../utils/textUtils.js';

export const botPool = mysql.createPool({
  host: env.BOT_DB_HOST,
  port: env.BOT_DB_PORT,
  user: env.BOT_DB_USER,
  password: env.BOT_DB_PASSWORD,
  database: env.BOT_DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
});

export const glpiPool = mysql.createPool({
  host: env.GLPI_DB_HOST,
  port: env.GLPI_DB_PORT,
  user: env.GLPI_DB_USER,
  password: env.GLPI_DB_PASSWORD,
  database: env.GLPI_DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
});

export const pool = botPool;

function normalizeMaxId(maxUserId) {
  return Number(maxUserId || 0);
}

function normalizeGlpiUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id || row.glpi_user_id || 0),
    name: row.name || row.glpi_user_name || '',
    realname: row.realname || row.glpi_realname || '',
    firstname: row.firstname || row.glpi_firstname || '',
    entity_id: Number(row.entity_id || row.glpi_entity_id || row.entities_id || 0),
    entity_name: row.entity_name || row.glpi_entity_name || '',
    email: row.email || '',
  };
}

async function executeBestEffort(poolInstance, sql, params = []) {
  try {
    await poolInstance.execute(sql, params);
    return true;
  } catch (error) {
    console.warn('DB best-effort query skipped:', error.message);
    return false;
  }
}

export async function ensureDatabaseSchema() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS bot_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      max_id BIGINT NOT NULL,
      email VARCHAR(255) DEFAULT NULL,
      glpi_user_id INT DEFAULT NULL,
      glpi_user_name VARCHAR(255) DEFAULT NULL,
      glpi_realname VARCHAR(255) DEFAULT NULL,
      glpi_firstname VARCHAR(255) DEFAULT NULL,
      glpi_entity_id INT DEFAULT 0,
      glpi_entity_name VARCHAR(255) DEFAULT NULL,
      is_authorized TINYINT(1) DEFAULT 0,
      is_blocked TINYINT(1) DEFAULT 0,
      last_login_at DATETIME DEFAULT NULL,
      last_glpi_sync_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_bot_users_max_id (max_id),
      KEY idx_bot_users_email (email),
      KEY idx_bot_users_glpi_user_id (glpi_user_id)
    )`,

    'ALTER TABLE bot_users ADD COLUMN email VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN glpi_user_id INT DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN glpi_user_name VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN glpi_realname VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN glpi_firstname VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN glpi_entity_id INT DEFAULT 0',
    'ALTER TABLE bot_users ADD COLUMN glpi_entity_name VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN is_authorized TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_users ADD COLUMN is_blocked TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_users ADD COLUMN last_login_at DATETIME DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN last_glpi_sync_at DATETIME DEFAULT NULL',
    'ALTER TABLE bot_users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE bot_users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    'ALTER TABLE bot_users ADD UNIQUE KEY uniq_bot_users_max_id (max_id)',
    'ALTER TABLE bot_users ADD KEY idx_bot_users_email (email)',
    'ALTER TABLE bot_users ADD KEY idx_bot_users_glpi_user_id (glpi_user_id)',

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
      decided_at DATETIME DEFAULT NULL,
      KEY idx_sds_requests_max_id (max_id),
      KEY idx_sds_requests_email (email),
      KEY idx_sds_requests_glpi_ticket_id (glpi_ticket_id)
    )`,

    'ALTER TABLE sds_requests ADD COLUMN glpi_ticket_id INT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN glpi_ticket_status INT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN decision_text TEXT DEFAULT NULL',
    'ALTER TABLE sds_requests ADD COLUMN decided_at DATETIME DEFAULT NULL',
    'ALTER TABLE sds_requests ADD KEY idx_sds_requests_max_id (max_id)',
    'ALTER TABLE sds_requests ADD KEY idx_sds_requests_email (email)',
    'ALTER TABLE sds_requests ADD KEY idx_sds_requests_glpi_ticket_id (glpi_ticket_id)',

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
      UNIQUE KEY uniq_glpi_ticket_id (glpi_ticket_id),
      KEY idx_bot_user_tickets_max_id (max_id),
      KEY idx_bot_user_tickets_glpi_user_id (glpi_user_id)
    )`,

    'ALTER TABLE bot_user_tickets ADD COLUMN solution_notified TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_user_tickets ADD COLUMN closed_notified TINYINT(1) DEFAULT 0',
    'ALTER TABLE bot_user_tickets ADD KEY idx_bot_user_tickets_max_id (max_id)',
    'ALTER TABLE bot_user_tickets ADD KEY idx_bot_user_tickets_glpi_user_id (glpi_user_id)',

    `CREATE TABLE IF NOT EXISTS bot_ticket_followups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      glpi_ticket_id INT NOT NULL,
      glpi_followup_id INT NOT NULL,
      content_hash CHAR(64) DEFAULT NULL,
      sent_to_max TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ticket_followup (glpi_ticket_id, glpi_followup_id)
    )`,

    'ALTER TABLE bot_ticket_followups ADD COLUMN content_hash CHAR(64) DEFAULT NULL',

    `CREATE TABLE IF NOT EXISTS bot_ticket_ratings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      max_id BIGINT NOT NULL,
      glpi_ticket_id INT NOT NULL,
      rating TINYINT NOT NULL,
      comment TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ticket_rating (glpi_ticket_id),
      KEY idx_bot_ticket_ratings_max_id (max_id)
    )`,

    'ALTER TABLE bot_ticket_ratings ADD COLUMN comment TEXT DEFAULT NULL',
    'ALTER TABLE bot_ticket_ratings ADD KEY idx_bot_ticket_ratings_max_id (max_id)',

    `CREATE TABLE IF NOT EXISTS bot_sessions (
      max_id BIGINT PRIMARY KEY,
      session_data JSON NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  ];

  for (const sql of queries) {
    try {
      await botPool.execute(sql);
    } catch (err) {
      if (
        err.code !== 'ER_DUP_FIELDNAME' &&
        err.code !== 'ER_TABLE_EXISTS_ERROR' &&
        err.code !== 'ER_DUP_KEYNAME'
      ) {
        console.error('BOT DB schema error:', err.message);
      }
    }
  }

  await executeBestEffort(
    glpiPool,
    'ALTER TABLE glpi_users ADD COLUMN max_id BIGINT DEFAULT NULL'
  );

  await executeBestEffort(
    glpiPool,
    'ALTER TABLE glpi_users ADD COLUMN is_blocked TINYINT(1) DEFAULT 0'
  );
}

export async function closeDb() {
  await Promise.all([
    botPool.end(),
    glpiPool.end(),
  ]);
}

export async function isMaxIdBlocked(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  const [blockedRows] = await botPool.execute(
    'SELECT 1 FROM blocked_max_ids WHERE max_id = ? LIMIT 1',
    [normalizedMaxId]
  );

  if (blockedRows.length > 0) {
    return true;
  }

  const [botUserRows] = await botPool.execute(
    `SELECT 1
     FROM bot_users
     WHERE max_id = ?
       AND is_blocked = 1
     LIMIT 1`,
    [normalizedMaxId]
  );

  return botUserRows.length > 0;
}

export async function blockMaxId(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  await botPool.execute(
    `INSERT INTO blocked_max_ids (max_id, blocked_at)
     VALUES (?, NOW())
     ON DUPLICATE KEY UPDATE blocked_at = NOW()`,
    [normalizedMaxId]
  );

  await botPool.execute(
    `INSERT INTO bot_users (max_id, is_blocked)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE
       is_blocked = 1,
       updated_at = NOW()`,
    [normalizedMaxId]
  );

  await executeBestEffort(
    glpiPool,
    'UPDATE glpi_users SET is_blocked = 1 WHERE max_id = ?',
    [normalizedMaxId]
  );
}

export async function unblockMaxId(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  await botPool.execute(
    'DELETE FROM blocked_max_ids WHERE max_id = ?',
    [normalizedMaxId]
  );

  await botPool.execute(
    `UPDATE bot_users
     SET is_blocked = 0,
         updated_at = NOW()
     WHERE max_id = ?`,
    [normalizedMaxId]
  );

  await executeBestEffort(
    glpiPool,
    'UPDATE glpi_users SET is_blocked = 0 WHERE max_id = ?',
    [normalizedMaxId]
  );
}

export async function getBotUserByMaxId(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  const [rows] = await botPool.execute(
    `SELECT
       id,
       max_id,
       email,
       glpi_user_id,
       glpi_user_name,
       glpi_realname,
       glpi_firstname,
       glpi_entity_id,
       glpi_entity_name,
       is_authorized,
       is_blocked,
       last_login_at,
       last_glpi_sync_at,
       created_at,
       updated_at
     FROM bot_users
     WHERE max_id = ?
     LIMIT 1`,
    [normalizedMaxId]
  );

  return rows[0] || null;
}

export async function getBotUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  const [rows] = await botPool.execute(
    `SELECT
       id,
       max_id,
       email,
       glpi_user_id,
       glpi_user_name,
       glpi_realname,
       glpi_firstname,
       glpi_entity_id,
       glpi_entity_name,
       is_authorized,
       is_blocked,
       last_login_at,
       last_glpi_sync_at,
       created_at,
       updated_at
     FROM bot_users
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [normalizedEmail]
  );

  return rows[0] || null;
}

async function getFreshGlpiUserById(glpiUserId) {
  const normalizedGlpiUserId = Number(glpiUserId || 0);

  if (!normalizedGlpiUserId) {
    return null;
  }

  try {
    const [rows] = await glpiPool.execute(
      `SELECT
         u.id,
         u.name,
         u.realname,
         u.firstname,
         u.entities_id AS entity_id,
         e.email
       FROM glpi_users u
       LEFT JOIN glpi_useremails e ON e.users_id = u.id
       WHERE u.id = ?
         AND u.is_active = 1
       ORDER BY e.is_default DESC, e.id ASC
       LIMIT 1`,
      [normalizedGlpiUserId]
    );

    return normalizeGlpiUserRow(rows[0]);
  } catch (error) {
    console.warn('getFreshGlpiUserById warning:', error.message);
    return null;
  }
}

async function getFreshGlpiUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  try {
    const [rows] = await glpiPool.execute(
      `SELECT
         u.id,
         u.name,
         u.realname,
         u.firstname,
         u.entities_id AS entity_id,
         e.email
       FROM glpi_users u
       INNER JOIN glpi_useremails e ON e.users_id = u.id
       WHERE LOWER(e.email) = ?
         AND u.is_active = 1
       ORDER BY u.id DESC
       LIMIT 1`,
      [normalizedEmail]
    );

    return normalizeGlpiUserRow(rows[0]);
  } catch (error) {
    console.warn('getFreshGlpiUserByEmail warning:', error.message);
    return null;
  }
}

export async function upsertBotUserFromGlpi(maxUserId, email, glpiUser, options = {}) {
  const normalizedMaxId = normalizeMaxId(maxUserId);
  const normalizedEmail = normalizeEmail(email || glpiUser?.email || '');
  const normalizedGlpiUser = normalizeGlpiUserRow(glpiUser);

  if (!normalizedMaxId) {
    throw new Error(`Некорректный MAX ID: ${maxUserId}`);
  }

  if (!normalizedGlpiUser?.id) {
    throw new Error('Некорректный GLPI user');
  }

  const authorized = options.isAuthorized === undefined
    ? 1
    : Number(options.isAuthorized ? 1 : 0);

  await botPool.execute(
    `INSERT INTO bot_users
      (
        max_id,
        email,
        glpi_user_id,
        glpi_user_name,
        glpi_realname,
        glpi_firstname,
        glpi_entity_id,
        glpi_entity_name,
        is_authorized,
        is_blocked,
        last_login_at,
        last_glpi_sync_at
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       email = COALESCE(VALUES(email), email),
       glpi_user_id = VALUES(glpi_user_id),
       glpi_user_name = VALUES(glpi_user_name),
       glpi_realname = VALUES(glpi_realname),
       glpi_firstname = VALUES(glpi_firstname),
       glpi_entity_id = VALUES(glpi_entity_id),
       glpi_entity_name = VALUES(glpi_entity_name),
       is_authorized = VALUES(is_authorized),
       is_blocked = 0,
       last_login_at = NOW(),
       last_glpi_sync_at = NOW(),
       updated_at = NOW()`,
    [
      normalizedMaxId,
      normalizedEmail || null,
      normalizedGlpiUser.id,
      normalizedGlpiUser.name || null,
      normalizedGlpiUser.realname || null,
      normalizedGlpiUser.firstname || null,
      normalizedGlpiUser.entity_id || 0,
      normalizedGlpiUser.entity_name || null,
      authorized,
    ]
  );
}

export async function updateBotUserGlpiData(maxUserId, glpiUser, email = null) {
  const normalizedMaxId = normalizeMaxId(maxUserId);
  const normalizedEmail = normalizeEmail(email || glpiUser?.email || '');
  const normalizedGlpiUser = normalizeGlpiUserRow(glpiUser);

  if (!normalizedMaxId || !normalizedGlpiUser?.id) {
    return;
  }

  await botPool.execute(
    `UPDATE bot_users
     SET email = COALESCE(?, email),
         glpi_user_id = ?,
         glpi_user_name = ?,
         glpi_realname = ?,
         glpi_firstname = ?,
         glpi_entity_id = ?,
         glpi_entity_name = ?,
         last_glpi_sync_at = NOW(),
         updated_at = NOW()
     WHERE max_id = ?`,
    [
      normalizedEmail || null,
      normalizedGlpiUser.id,
      normalizedGlpiUser.name || null,
      normalizedGlpiUser.realname || null,
      normalizedGlpiUser.firstname || null,
      normalizedGlpiUser.entity_id || 0,
      normalizedGlpiUser.entity_name || null,
      normalizedMaxId,
    ]
  );
}

export async function markBotUserAuthorized(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  await botPool.execute(
    `UPDATE bot_users
     SET is_authorized = 1,
         is_blocked = 0,
         last_login_at = NOW(),
         updated_at = NOW()
     WHERE max_id = ?`,
    [normalizedMaxId]
  );
}

export async function findGlpiUserByMaxId(maxUserId) {
  const normalizedMaxId = normalizeMaxId(maxUserId);

  const botUser = await getBotUserByMaxId(normalizedMaxId);

  if (botUser && Number(botUser.is_blocked || 0) === 1) {
    return null;
  }

  if (botUser && Number(botUser.is_authorized || 0) === 1) {
    let freshUser = null;

    if (botUser.glpi_user_id) {
      freshUser = await getFreshGlpiUserById(botUser.glpi_user_id);
    }

    if (!freshUser && botUser.email) {
      freshUser = await getFreshGlpiUserByEmail(botUser.email);
    }

    if (freshUser) {
      await updateBotUserGlpiData(normalizedMaxId, freshUser, botUser.email);

      return {
        ...freshUser,
        email: botUser.email || freshUser.email || '',
      };
    }

    if (botUser.glpi_user_id) {
      return {
        id: Number(botUser.glpi_user_id),
        name: botUser.glpi_user_name || '',
        realname: botUser.glpi_realname || '',
        firstname: botUser.glpi_firstname || '',
        entity_id: Number(botUser.glpi_entity_id || 0),
        entity_name: botUser.glpi_entity_name || '',
        email: botUser.email || '',
      };
    }
  }

  try {
    const [rows] = await glpiPool.execute(
      `SELECT
         u.id,
         u.name,
         u.realname,
         u.firstname,
         u.entities_id AS entity_id,
         e.email
       FROM glpi_users u
       LEFT JOIN glpi_useremails e ON e.users_id = u.id
       WHERE u.max_id = ?
         AND u.is_active = 1
         AND COALESCE(u.is_blocked, 0) = 0
       ORDER BY e.is_default DESC, e.id ASC
       LIMIT 1`,
      [normalizedMaxId]
    );

    const user = normalizeGlpiUserRow(rows[0]);

    if (user) {
      await upsertBotUserFromGlpi(normalizedMaxId, user.email || null, user, {
        isAuthorized: true,
      });
    }

    return user;
  } catch (error) {
    console.warn('findGlpiUserByMaxId GLPI fallback warning:', error.message);
    return null;
  }
}

export async function findGlpiUserAfterSdsImport(email) {
  return await getFreshGlpiUserByEmail(email);
}

export async function linkMaxIdToGlpiUser(glpiUserId, maxUserId, email = null) {
  const normalizedMaxId = normalizeMaxId(maxUserId);
  const normalizedGlpiUserId = Number(glpiUserId || 0);
  const normalizedEmail = normalizeEmail(email || '');

  const user = await getFreshGlpiUserById(normalizedGlpiUserId);

  if (user) {
    await upsertBotUserFromGlpi(normalizedMaxId, normalizedEmail || user.email || null, user, {
      isAuthorized: true,
    });
  } else {
    await botPool.execute(
      `INSERT INTO bot_users
        (max_id, email, glpi_user_id, is_authorized, is_blocked, last_login_at)
       VALUES (?, ?, ?, 1, 0, NOW())
       ON DUPLICATE KEY UPDATE
         email = COALESCE(VALUES(email), email),
         glpi_user_id = VALUES(glpi_user_id),
         is_authorized = 1,
         is_blocked = 0,
         last_login_at = NOW(),
         updated_at = NOW()`,
      [normalizedMaxId, normalizedEmail || null, normalizedGlpiUserId]
    );
  }

  await executeBestEffort(
    glpiPool,
    `UPDATE glpi_users
     SET max_id = ?, is_blocked = 0, is_active = 1
     WHERE id = ?`,
    [normalizedMaxId, normalizedGlpiUserId]
  );
}

export async function createSdsRequest(maxUserId, email, data) {
  const [result] = await botPool.execute(
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
  await botPool.execute(
    `UPDATE sds_requests
     SET glpi_ticket_id = ?
     WHERE id = ?`,
    [glpiTicketId, requestId]
  );
}

export async function getPendingSdsRequests(limit = 20) {
  const [rows] = await botPool.execute(
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
  await botPool.execute(
    `UPDATE sds_requests
     SET glpi_ticket_status = ?
     WHERE id = ?`,
    [ticketStatus || null, requestId]
  );
}

export async function approveSdsRequest(requestId, decisionText, ticketStatus) {
  await botPool.execute(
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
  await botPool.execute(
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
  await botPool.execute(
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
  const [rows] = await botPool.execute(
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
  const [rows] = await botPool.execute(
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
  const [rows] = await botPool.execute(
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
    await botPool.execute(
      `UPDATE bot_user_tickets
       SET status = ?, title = ?
       WHERE glpi_ticket_id = ?`,
      [status, title, ticketId]
    );
    return;
  }

  await botPool.execute(
    `UPDATE bot_user_tickets
     SET status = ?
     WHERE glpi_ticket_id = ?`,
    [status, ticketId]
  );
}

export async function markTicketSolutionNotified(ticketId) {
  await botPool.execute(
    `UPDATE bot_user_tickets
     SET solution_notified = 1
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function resetTicketSolutionNotified(ticketId) {
  await botPool.execute(
    `UPDATE bot_user_tickets
     SET solution_notified = 0
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function markTicketClosedNotified(ticketId) {
  await botPool.execute(
    `UPDATE bot_user_tickets
     SET closed_notified = 1
     WHERE glpi_ticket_id = ?`,
    [ticketId]
  );
}

export async function markFollowupAsKnown(ticketId, followupId, content, sentToMax) {
  await botPool.execute(
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
  const [rows] = await botPool.execute(
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

  await botPool.execute(
    'DELETE FROM bot_ticket_followups WHERE glpi_ticket_id = ?',
    [normalizedTicketId]
  );

  await botPool.execute(
    'DELETE FROM bot_user_tickets WHERE glpi_ticket_id = ?',
    [normalizedTicketId]
  );
}

export async function getBotTicketRating(ticketId) {
  const normalizedTicketId = Number(ticketId || 0);

  if (!normalizedTicketId) {
    return null;
  }

  const [rows] = await botPool.execute(
    `SELECT id, max_id, glpi_ticket_id, rating, created_at
     FROM bot_ticket_ratings
     WHERE glpi_ticket_id = ?
     LIMIT 1`,
    [normalizedTicketId]
  );

  return rows[0] || null;
}

export async function saveBotTicketRating(maxUserId, ticketId, rating, comment = null) {
  const normalizedMaxUserId = Number(maxUserId || 0);
  const normalizedTicketId = Number(ticketId || 0);
  const normalizedRating = Number(rating || 0);

  if (!normalizedMaxUserId) {
    throw new Error(`Некорректный MAX ID: ${maxUserId}`);
  }

  if (!normalizedTicketId) {
    throw new Error(`Некорректный номер заявки: ${ticketId}`);
  }

  if (!Number.isInteger(normalizedRating) || normalizedRating < 0 || normalizedRating > 5) {
    throw new Error(`Некорректная оценка: ${rating}`);
  }

  const [result] = await botPool.execute(
    `INSERT IGNORE INTO bot_ticket_ratings
      (max_id, glpi_ticket_id, rating, comment)
     VALUES (?, ?, ?, ?)`,
    [normalizedMaxUserId, normalizedTicketId, normalizedRating, comment || null]
  );

  return result.affectedRows === 1;
}