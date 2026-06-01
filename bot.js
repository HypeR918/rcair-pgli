import { Bot, Keyboard } from '@maxhub/max-bot-api';
import mysql from 'mysql2/promise';
import axios from 'axios';
import http from 'node:http';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const bot = new Bot(process.env.BOT_TOKEN);
const PORT = Number(process.env.PORT || 3000);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
});

const State = {
  IDLE: 'IDLE',

  WAIT_UNLOCK_EMAIL: 'WAIT_UNLOCK_EMAIL',
  WAIT_NEW_USER_EMAIL: 'WAIT_NEW_USER_EMAIL',
  WAIT_EMAIL_VERIFICATION_CODE: 'WAIT_EMAIL_VERIFICATION_CODE',

  WAIT_SDS_ORG: 'WAIT_SDS_ORG',
  WAIT_SDS_DEPT: 'WAIT_SDS_DEPT',
  WAIT_SDS_FIO: 'WAIT_SDS_FIO',
  WAIT_SDS_POSITION: 'WAIT_SDS_POSITION',
  WAIT_SDS_PHONE: 'WAIT_SDS_PHONE',
  WAIT_SDS_ISSUE: 'WAIT_SDS_ISSUE',
  WAIT_SDS_APPROVAL: 'WAIT_SDS_APPROVAL',
};

const sessions = new Map();

const EMAIL_VERIFICATION_ENABLED =
  String(process.env.EMAIL_VERIFICATION_ENABLED || 'true').toLowerCase() === 'true';

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_PORT || '465') === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateEmailVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailVerificationCode(email, code) {
  await emailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Код подтверждения email',
    text: `Ваш код подтверждения: ${code}`,
  });
}

async function startEmailVerification(ctx, email, flow) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(email);
  const code = generateEmailVerificationCode();

  sessions.set(maxUserId, {
    state: State.WAIT_EMAIL_VERIFICATION_CODE,
    verificationEmail: normalizedEmail,
    verificationCode: code,
    verificationAttempts: 0,
    verificationExpiresAt: Date.now() + 10 * 60 * 1000,
    verificationFlow: flow,
  });

  await sendEmailVerificationCode(normalizedEmail, code);
  await ctx.reply('Код подтверждения отправлен на email. Введите код из письма:');
}

async function ensureDatabaseSchema() {
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
  ];

  for (const sql of queries) {
    try {
      await pool.execute(sql);
    } catch (err) {
      if (
        err.code !== 'ER_DUP_FIELDNAME' &&
        err.code !== 'ER_TABLE_EXISTS_ERROR'
      ) {
        console.error('DB schema error:', err.message);
      }
    }
  }
}

async function isMaxIdBlocked(maxUserId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM blocked_max_ids WHERE max_id = ? LIMIT 1',
    [maxUserId]
  );

  return rows.length > 0;
}

async function blockMaxId(maxUserId) {
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

async function unblockMaxId(maxUserId) {
  await pool.execute(
    'DELETE FROM blocked_max_ids WHERE max_id = ?',
    [maxUserId]
  );

  await pool.execute(
    'UPDATE glpi_users SET is_blocked = 0 WHERE max_id = ?',
    [maxUserId]
  );
}

async function findGlpiUserByMaxId(maxUserId) {
  const [rows] = await pool.execute(
    `SELECT id, name, realname, firstname
     FROM glpi_users
     WHERE max_id = ?
       AND is_active = 1
       AND COALESCE(is_blocked, 0) = 0
     LIMIT 1`,
    [maxUserId]
  );

  return rows[0] || null;
}

async function findGlpiUserAfterSdsImport(email) {
  const normalizedEmail = normalizeEmail(email);

  const [rows] = await pool.execute(
    `SELECT
       u.id,
       u.name,
       u.realname,
       u.firstname
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

async function linkMaxIdToGlpiUser(glpiUserId, maxUserId) {
  await pool.execute(
    `UPDATE glpi_users
     SET max_id = ?, is_blocked = 0, is_active = 1
     WHERE id = ?`,
    [maxUserId, glpiUserId]
  );
}

async function requestGlpiLdapImport(email) {
  if (!process.env.GLPI_IMPORT_URL) {
    console.error('GLPI_IMPORT_URL is not configured');
    return false;
  }

  if (!process.env.GLPI_IMPORT_SECRET) {
    console.error('GLPI_IMPORT_SECRET is not configured');
    return false;
  }

  try {
    const res = await axios.post(
      process.env.GLPI_IMPORT_URL,
      { email },
      {
        headers: {
          Authorization: `Bearer ${process.env.GLPI_IMPORT_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: Number(process.env.GLPI_IMPORT_TIMEOUT_MS || 130000),
        validateStatus: () => true,
      }
    );

    if (res.status >= 200 && res.status < 300 && res.data?.ok === true) {
      console.log('=== GLPI CLI IMPORT SUCCESS ===');
      console.log('email:', email);
      console.log('filter:', res.data.filter);
      return true;
    }

    console.error('=== GLPI CLI IMPORT FAILED ===');
    console.error('status:', res.status);
    console.error('data:', res.data);
    return false;
  } catch (err) {
    console.error('=== GLPI CLI IMPORT REQUEST ERROR ===');
    console.error(err.message);
    return false;
  }
}

async function importUserFromSdsViaGlpi(email) {
  const normalizedEmail = normalizeEmail(email);

  console.log('=== SDS/GLPI IMPORT START ===');
  console.log('email:', normalizedEmail);

  const importRequested = await requestGlpiLdapImport(normalizedEmail);

  if (!importRequested) {
    console.log('=== GLPI CLI IMPORT WAS NOT STARTED OR FAILED ===');
    return null;
  }

  console.log('=== CHECKING GLPI USER AFTER SDS IMPORT ===');

  const attempts = Number(process.env.GLPI_IMPORT_CHECK_ATTEMPTS || 10);
  const delayMs = Number(process.env.GLPI_IMPORT_CHECK_DELAY_MS || 1500);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(delayMs);

    const user = await findGlpiUserAfterSdsImport(normalizedEmail);

    if (user) {
      console.log('=== USER FOUND AFTER SDS IMPORT ===');
      console.log('user id:', user.id);
      console.log('attempt:', attempt);
      return user;
    }
  }

  console.log('=== USER NOT FOUND AFTER SDS IMPORT ===');
  return null;
}

async function createSdsRequest(maxUserId, email, data) {
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

async function updateSdsRequestGlpiTicketId(requestId, glpiTicketId) {
  await pool.execute(
    `UPDATE sds_requests
     SET glpi_ticket_id = ?
     WHERE id = ?`,
    [glpiTicketId, requestId]
  );
}

function getGlpiApiBaseUrl() {
  const url = String(process.env.GLPI_API_URL || '').trim();

  if (!url) {
    throw new Error('GLPI_API_URL is not configured');
  }

  return url.replace(/\/+$/, '');
}

function getGlpiApiHeaders(sessionToken) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (sessionToken) {
    headers['Session-Token'] = sessionToken;
  }

  if (process.env.GLPI_API_APP_TOKEN) {
    headers['App-Token'] = process.env.GLPI_API_APP_TOKEN;
  }

  return headers;
}

async function glpiInitSession() {
  if (!process.env.GLPI_API_USER_TOKEN) {
    throw new Error('GLPI_API_USER_TOKEN is not configured');
  }

  const baseUrl = getGlpiApiBaseUrl();

  const res = await axios.get(`${baseUrl}/initSession`, {
    headers: {
      ...getGlpiApiHeaders(),
      Authorization: `user_token ${process.env.GLPI_API_USER_TOKEN}`,
    },
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300 || !res.data?.session_token) {
    console.error('GLPI initSession failed:', res.status, res.data);
    throw new Error('GLPI initSession failed');
  }

  return res.data.session_token;
}

async function glpiKillSession(sessionToken) {
  if (!sessionToken) return;

  try {
    const baseUrl = getGlpiApiBaseUrl();

    await axios.get(`${baseUrl}/killSession`, {
      headers: getGlpiApiHeaders(sessionToken),
      validateStatus: () => true,
    });
  } catch (err) {
    console.error('GLPI killSession error:', err.message);
  }
}

async function glpiApiRequest(method, path, data = null) {
  const sessionToken = await glpiInitSession();

  try {
    const baseUrl = getGlpiApiBaseUrl();
    const lowerMethod = method.toLowerCase();

    const needsWriteSession = ['post', 'put', 'patch', 'delete'].includes(lowerMethod);
    const separator = path.includes('?') ? '&' : '?';
    const finalPath = needsWriteSession
      ? `${path}${separator}session_write=true`
      : path;

    const config = {
      method,
      url: `${baseUrl}${finalPath}`,
      headers: getGlpiApiHeaders(sessionToken),
      validateStatus: () => true,
    };

    // ВАЖНО:
    // GLPI запрещает body у GET-запросов.
    // Поэтому data добавляем только для POST/PUT/PATCH/DELETE.
    if (data !== null && data !== undefined && lowerMethod !== 'get') {
      config.data = data;
    }

    const res = await axios(config);

    if (res.status < 200 || res.status >= 300) {
      console.error('GLPI API request failed:', method, finalPath, res.status, res.data);
      throw new Error(`GLPI API request failed: ${res.status}`);
    }

    return res.data;
  } finally {
    await glpiKillSession(sessionToken);
  }
}

function buildRegistrationTicketContent(maxUserId, email, data) {
  return [
    'Пользователь не найден в SDS-helpdesk после проверки через LDAP/GLPI.',
    '',
    `Email: ${email}`,
    `MAX ID: ${maxUserId}`,
    '',
    `Организация: ${data.org || '-'}`,
    `Подразделение: ${data.dept || '-'}`,
    `ФИО: ${data.fio || '-'}`,
    `Должность: ${data.position || '-'}`,
    `Телефон: ${data.phone || '-'}`,
    '',
    'Содержание обращения:',
    data.issue || '-',
    '',
    'Формат решения:',
    'ПОДТВЕРДИТЬ - пользователь создан / доступ разрешен',
    'ОТКАЗАТЬ - отказано, указать причину',
    '',
    'Примеры решения:',
    '',
    'ПОДТВЕРДИТЬ',
    'Пользователь создан в SDS и добавлен в группу helpdesk.',
    '',
    'или',
    '',
    'ОТКАЗАТЬ',
    'Недостаточно данных для идентификации пользователя.',
  ].join('\n');
}

async function createGlpiRegistrationTicket(maxUserId, email, data) {
  const entityId = Number(process.env.GLPI_ENTITY_ID || 0);

  const ticketPayload = {
    input: {
      name: `Регистрация пользователя в SDS-helpdesk: ${data.fio || email}`,
      content: buildRegistrationTicketContent(maxUserId, email, data),
      entities_id: entityId,
      type: 2,
      urgency: 3,
      impact: 3,
      priority: 3,
    },
  };

  const result = await glpiApiRequest('post', '/Ticket', ticketPayload);

  if (!result?.id) {
    console.error('GLPI Ticket create unexpected response:', result);
    throw new Error('GLPI ticket was not created');
  }

  return result.id;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseDecisionText(text) {
  const normalized = stripHtml(text).trim();

  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const firstLineUpper = String(lines[0] || '').toUpperCase();
  const fullUpper = normalized.toUpperCase();

  if (
    firstLineUpper.includes('ПОДТВЕРДИТЬ') ||
    firstLineUpper.includes('ПОДТВЕРЖДЕНО') ||
    firstLineUpper.includes('ПОДТВЕРЖДАЮ') ||
    firstLineUpper.includes('ОДОБРЕНО') ||
    firstLineUpper.includes('ОДОБРИТЬ') ||
    firstLineUpper.includes('СОГЛАСОВАНО') ||
    firstLineUpper.includes('СОГЛАСОВАТЬ')
  ) {
    return {
      status: 'APPROVED',
      text: normalized,
    };
  }

  if (
    firstLineUpper.includes('ОТКАЗАТЬ') ||
    firstLineUpper.includes('ОТКАЗАНО') ||
    firstLineUpper.includes('ОТКАЗ') ||
    firstLineUpper.includes('ОТКЛОНЕНО') ||
    firstLineUpper.includes('ОТКЛОНИТЬ')
  ) {
    return {
      status: 'REJECTED',
      text: normalized,
    };
  }

  if (fullUpper.includes('APPROVED')) {
    return {
      status: 'APPROVED',
      text: normalized,
    };
  }

  if (fullUpper.includes('REJECTED')) {
    return {
      status: 'REJECTED',
      text: normalized,
    };
  }

  return null;
}

async function getGlpiTicket(ticketId) {
  return await glpiApiRequest('get', `/Ticket/${ticketId}`);
}

async function getGlpiTicketSolutions(ticketId) {
  try {
    const result = await glpiApiRequest('get', `/Ticket/${ticketId}/ITILSolution`);

    if (Array.isArray(result)) {
      return result;
    }

    return [];
  } catch (err) {
    console.error('getGlpiTicketSolutions error:', err.message);
    return [];
  }
}

async function getGlpiTicketFollowups(ticketId) {
  try {
    const result = await glpiApiRequest('get', `/Ticket/${ticketId}/ITILFollowup`);

    if (Array.isArray(result)) {
      return result;
    }

    return [];
  } catch (err) {
    console.error('getGlpiTicketFollowups error:', err.message);
    return [];
  }
}

async function getTicketDecision(ticketId) {
  const ticket = await getGlpiTicket(ticketId);
  const ticketStatus = Number(ticket.status || 0);

  const isFinalStatus = ticketStatus === 5 || ticketStatus === 6;

  if (!isFinalStatus) {
    return {
      isFinal: false,
      ticketStatus,
      decision: null,
    };
  }

  const solutions = await getGlpiTicketSolutions(ticketId);

  for (const solution of [...solutions].reverse()) {
    const decision = parseDecisionText(
      solution.content ||
      solution.solution ||
      solution.name ||
      ''
    );

    if (decision) {
      return {
        isFinal: true,
        ticketStatus,
        decision,
      };
    }
  }

  const followups = await getGlpiTicketFollowups(ticketId);

  for (const followup of [...followups].reverse()) {
    const decision = parseDecisionText(followup.content || '');

    if (decision) {
      return {
        isFinal: true,
        ticketStatus,
        decision,
      };
    }
  }

  const fallbackDecision = parseDecisionText(ticket.content || '');

  return {
    isFinal: true,
    ticketStatus,
    decision: fallbackDecision,
  };
}

const mainMenuKeyboard = () =>
  Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Новая', 'menu:new')],
    [Keyboard.button.callback('Выбрать', 'menu:list')],
    [Keyboard.button.callback('Справка', 'menu:help')],
    [Keyboard.button.callback('Выйти', 'menu:logout', { intent: 'negative' })],
  ]);

async function showWelcomeAndMenu(ctx, user) {
  const maxUserId = ctx.user.user_id;

  sessions.set(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  const fio =
    `${user.firstname || ''} ${user.realname || ''}`.trim() ||
    user.name ||
    'пользователь';

  await ctx.reply(`Добро пожаловать, ${fio}!`, {
    attachments: [mainMenuKeyboard()],
  });
}

async function proceedAfterVerification(ctx, verifiedEmail) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(verifiedEmail);

  await ctx.reply('Проверяю наличие учетной записи в SDS-helpdesk...');

  const importResult = await importUserFromSdsViaGlpi(normalizedEmail);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId);

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await ctx.reply('Учетная запись найдена в SDS-helpdesk и успешно привязана.');
      await showWelcomeAndMenu(ctx, user);
      return;
    }
  }

  sessions.set(maxUserId, {
    state: State.WAIT_SDS_ORG,
    verifiedEmail: normalizedEmail,
    sdsData: {},
  });

  await ctx.reply('Учетная запись не найдена в SDS-helpdesk. Начинаем регистрацию.');
  await ctx.reply('Введите название организации:');
}

async function entryPoint(ctx) {
  const maxUserId = ctx.user.user_id;

  await ctx.reply('Проверка доступа...');

  try {
    const blocked = await isMaxIdBlocked(maxUserId);

    if (blocked) {
      sessions.set(maxUserId, {
        state: State.WAIT_UNLOCK_EMAIL,
        attempts: 0,
      });

      await ctx.reply('Ваш MAX ID заблокирован. Для разблокировки нужно подтвердить корпоративный email.');
      await ctx.reply('Введите ваш корпоративный email:');
      return;
    }

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await showWelcomeAndMenu(ctx, user);
      return;
    }

    sessions.set(maxUserId, {
      state: State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply('Ваш MAX ID не найден в системе SDS-helpdesk.');
    await ctx.reply('Введите ваш корпоративный email для входа:');
  } catch (error) {
    console.error('entryPoint error:', error);
    await ctx.reply('Ошибка подключения к базе данных.');
  }
}

async function handleEmailInput(ctx, email, flow) {
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    await ctx.reply('Некорректный формат email. Попробуйте снова:');
    return;
  }

  if (EMAIL_VERIFICATION_ENABLED) {
    await startEmailVerification(ctx, normalizedEmail, flow);
    return;
  }

  sessions.set(ctx.user.user_id, {
    state: State.IDLE,
  });

  await proceedAfterVerification(ctx, normalizedEmail);
}

async function handleApprovedSdsRequest(request) {
  const maxUserId = request.max_id;
  const email = normalizeEmail(request.email);

  await pool.execute(
    `UPDATE sds_requests
     SET status = 'APPROVED',
         decision_text = ?,
         glpi_ticket_status = ?,
         decided_at = NOW()
     WHERE id = ?`,
    [
      request.decision_text || 'ПОДТВЕРДИТЬ',
      request.glpi_ticket_status || null,
      request.id,
    ]
  );

  await bot.api.sendMessageToUser(
    maxUserId,
    'Заявка подтверждена. Проверяю учетную запись в SDS-helpdesk.'
  );

  const importResult = await importUserFromSdsViaGlpi(email);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId);

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      const fakeCtx = {
        user: { user_id: maxUserId },
        reply: (text, options) => bot.api.sendMessageToUser(maxUserId, text, options),
      };

      await bot.api.sendMessageToUser(
        maxUserId,
        'Учетная запись найдена и успешно привязана.'
      );

      await showWelcomeAndMenu(fakeCtx, user);
      return;
    }
  }

  await bot.api.sendMessageToUser(
    maxUserId,
    'Заявка подтверждена, но учетная запись пока не найдена в SDS-helpdesk. Обратитесь к администратору.'
  );
}

async function handleRejectedSdsRequest(request) {
  const maxUserId = request.max_id;

  await pool.execute(
    `UPDATE sds_requests
     SET status = 'REJECTED',
         decision_text = ?,
         glpi_ticket_status = ?,
         decided_at = NOW()
     WHERE id = ?`,
    [
      request.decision_text || 'ОТКАЗАТЬ',
      request.glpi_ticket_status || null,
      request.id,
    ]
  );

  sessions.delete(maxUserId);

  await bot.api.sendMessageToUser(
    maxUserId,
    `По заявке получен отказ.\n\n${request.decision_text || 'Причина отказа не указана.'}`
  );
}

let approvalPollingInProgress = false;

async function pollPendingSdsRequests() {
  if (approvalPollingInProgress) {
    return;
  }

  approvalPollingInProgress = true;

  try {
    const [requests] = await pool.execute(
      `SELECT id, max_id, email, glpi_ticket_id
       FROM sds_requests
       WHERE status = 'PENDING'
         AND glpi_ticket_id IS NOT NULL
       ORDER BY id ASC
       LIMIT 20`
    );

    for (const request of requests) {
      try {
        const result = await getTicketDecision(request.glpi_ticket_id);

        await pool.execute(
          `UPDATE sds_requests
           SET glpi_ticket_status = ?
           WHERE id = ?`,
          [result.ticketStatus || null, request.id]
        );

        if (!result.isFinal) {
          continue;
        }

        if (!result.decision) {
          console.log(
            'Ticket is final but decision is not recognized:',
            request.glpi_ticket_id
          );
          continue;
        }

        const enrichedRequest = {
          ...request,
          glpi_ticket_status: result.ticketStatus,
          decision_text: result.decision.text,
        };

        if (result.decision.status === 'APPROVED') {
          await handleApprovedSdsRequest(enrichedRequest);
          continue;
        }

        if (result.decision.status === 'REJECTED') {
          await handleRejectedSdsRequest(enrichedRequest);
          continue;
        }
      } catch (err) {
        console.error(
          'pollPendingSdsRequests item error:',
          request.glpi_ticket_id,
          err.message
        );
      }
    }
  } catch (err) {
    console.error('pollPendingSdsRequests error:', err.message);
  } finally {
    approvalPollingInProgress = false;
  }
}

bot.on('bot_started', async ctx => {
  await entryPoint(ctx);
});

bot.command('start', async ctx => {
  await entryPoint(ctx);
});

bot.on('message_created', async ctx => {
  if (!ctx.message || !ctx.message.body || !ctx.message.body.text) return;
  if (!ctx.user || !ctx.user.user_id) return;

  const maxUserId = ctx.user.user_id;
  const session = sessions.get(maxUserId);

  if (!session) return;

  const text = ctx.message.body.text.trim();

  try {
    if (session.state === State.WAIT_UNLOCK_EMAIL) {
      await handleEmailInput(ctx, text, State.WAIT_UNLOCK_EMAIL);
      return;
    }

    if (session.state === State.WAIT_NEW_USER_EMAIL) {
      await handleEmailInput(ctx, text, State.WAIT_NEW_USER_EMAIL);
      return;
    }

    if (session.state === State.WAIT_EMAIL_VERIFICATION_CODE) {
      if (Date.now() > session.verificationExpiresAt) {
        sessions.set(maxUserId, {
          state:
            session.verificationFlow === State.WAIT_UNLOCK_EMAIL
              ? State.WAIT_UNLOCK_EMAIL
              : State.WAIT_NEW_USER_EMAIL,
        });

        await ctx.reply('Срок действия кода истек. Введите email заново:');
        return;
      }

      if (text !== session.verificationCode) {
        const attempts = Number(session.verificationAttempts || 0) + 1;
        session.verificationAttempts = attempts;

        if (attempts >= 2) {
          await blockMaxId(maxUserId);
          sessions.delete(maxUserId);

          await ctx.reply('Код введен неверно два раза. Ваш MAX ID заблокирован.');
          return;
        }

        sessions.set(maxUserId, session);
        await ctx.reply('Код неверный. Попробуйте еще раз:');
        return;
      }

      const verifiedEmail = session.verificationEmail;
      const wasUnlockFlow = session.verificationFlow === State.WAIT_UNLOCK_EMAIL;

      if (wasUnlockFlow) {
        await unblockMaxId(maxUserId);
        await ctx.reply('MAX ID разблокирован.');
      }

      sessions.set(maxUserId, {
        state: State.IDLE,
      });

      await proceedAfterVerification(ctx, verifiedEmail);
      return;
    }

    if (session.state === State.WAIT_SDS_ORG) {
      session.sdsData.org = text;
      session.state = State.WAIT_SDS_DEPT;
      sessions.set(maxUserId, session);

      await ctx.reply('Введите подразделение:');
      return;
    }

    if (session.state === State.WAIT_SDS_DEPT) {
      session.sdsData.dept = text;
      session.state = State.WAIT_SDS_FIO;
      sessions.set(maxUserId, session);

      await ctx.reply('Введите ФИО полностью:');
      return;
    }

    if (session.state === State.WAIT_SDS_FIO) {
      session.sdsData.fio = text;
      session.state = State.WAIT_SDS_POSITION;
      sessions.set(maxUserId, session);

      await ctx.reply('Введите должность:');
      return;
    }

    if (session.state === State.WAIT_SDS_POSITION) {
      session.sdsData.position = text;
      session.state = State.WAIT_SDS_PHONE;
      sessions.set(maxUserId, session);

      await ctx.reply('Введите телефон:');
      return;
    }

    if (session.state === State.WAIT_SDS_PHONE) {
      session.sdsData.phone = text;
      session.state = State.WAIT_SDS_ISSUE;
      sessions.set(maxUserId, session);

      await ctx.reply('Опишите содержание обращения:');
      return;
    }

    if (session.state === State.WAIT_SDS_ISSUE) {
      session.sdsData.issue = text;

      await ctx.reply('Создаю заявку в SDS-helpdesk для администраторов...');

      const localRequestId = await createSdsRequest(
        maxUserId,
        session.verifiedEmail,
        session.sdsData
      );

      const glpiTicketId = await createGlpiRegistrationTicket(
        maxUserId,
        session.verifiedEmail,
        session.sdsData
      );

      await updateSdsRequestGlpiTicketId(localRequestId, glpiTicketId);

      session.state = State.WAIT_SDS_APPROVAL;
      session.sdsRequestId = localRequestId;
      session.glpiTicketId = glpiTicketId;
      sessions.set(maxUserId, session);

      await ctx.reply(`Заявка №${glpiTicketId} создана и передана администраторам.`);
      await ctx.reply('Ожидайте решения по заявке. Я пришлю уведомление после обработки.');
      return;
    }

    if (session.state === State.WAIT_SDS_APPROVAL) {
      await ctx.reply('Заявка находится на рассмотрении администраторов.');
      return;
    }

    await ctx.reply('Используйте меню или отправьте /start.');
  } catch (error) {
    console.error('message_created error:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('menu:new', async ctx => {
  await ctx.reply('Функционал создания заявки будет добавлен на следующем этапе.');
});

bot.action('menu:list', async ctx => {
  await ctx.reply('Функционал списка заявок будет добавлен на следующем этапе.');
});

bot.action('menu:help', async ctx => {
  await ctx.reply('Бот для работы с заявками SDS-helpdesk. Используйте кнопки меню для навигации.');
});

bot.action('menu:logout', async ctx => {
  if (ctx.user && ctx.user.user_id) {
    sessions.delete(ctx.user.user_id);
  }

  await ctx.reply('Сессия завершена. Отправьте /start для входа.');
});

const webhookServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'max-bot' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook/sds-approval') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';

  req.on('data', chunk => {
    body += chunk;

    if (body.length > 16 * 1024) {
      req.destroy();
    }
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const maxUserId = Number(payload.maxUserId);
      const statusRaw = String(payload.status || '').toUpperCase();

      let status = statusRaw;

      if (
        statusRaw === 'ПОДТВЕРДИТЬ' ||
        statusRaw === 'ПОДТВЕРЖДЕНО' ||
        statusRaw === 'ОДОБРЕНО' ||
        statusRaw === 'СОГЛАСОВАНО'
      ) {
        status = 'APPROVED';
      }

      if (
        statusRaw === 'ОТКАЗАТЬ' ||
        statusRaw === 'ОТКАЗАНО' ||
        statusRaw === 'ОТКЛОНЕНО'
      ) {
        status = 'REJECTED';
      }

      if (!maxUserId || !['APPROVED', 'REJECTED'].includes(status)) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }

      const [requests] = await pool.execute(
        `SELECT id, max_id, email, glpi_ticket_id
         FROM sds_requests
         WHERE max_id = ?
           AND status = 'PENDING'
         ORDER BY id DESC
         LIMIT 1`,
        [maxUserId]
      );

      if (requests.length === 0) {
        res.writeHead(404);
        res.end('No pending request');
        return;
      }

      const request = {
        ...requests[0],
        glpi_ticket_status: null,
        decision_text: status === 'APPROVED' ? 'ПОДТВЕРДИТЬ' : 'ОТКАЗАТЬ',
      };

      if (status === 'APPROVED') {
        await handleApprovedSdsRequest(request);
      } else {
        await handleRejectedSdsRequest(request);
      }

      res.writeHead(200);
      res.end('OK');
    } catch (error) {
      console.error('approval webhook error:', error);

      res.writeHead(400);
      res.end('Bad request');
    }
  });
});

async function startApp() {
  await ensureDatabaseSchema();

  bot.start();

  const pollMs = Number(process.env.GLPI_APPROVAL_POLL_MS || 60000);

  setInterval(() => {
    pollPendingSdsRequests().catch(err => {
      console.error('approval polling fatal error:', err.message);
    });
  }, pollMs);

  pollPendingSdsRequests().catch(err => {
    console.error('approval polling startup error:', err.message);
  });

  webhookServer.listen(PORT, () => {
    console.log(`Бот запущен. Webhook: http://localhost:${PORT}/webhook/sds-approval`);
    console.log(`Healthcheck: http://localhost:${PORT}/health`);
    console.log('GLPI approval polling interval:', pollMs, 'ms');
    console.log('Email verification enabled:', EMAIL_VERIFICATION_ENABLED);
  });
}

startApp();

async function shutdown() {
  console.log('Завершение работы...');
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);