import { Bot, Keyboard } from '@maxhub/max-bot-api';
import mysql from 'mysql2/promise';
import axios from 'axios';
import http from 'node:http';
// import nodemailer from 'nodemailer';
import 'dotenv/config';

const bot = new Bot(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
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
  // WAIT_EMAIL_VERIFICATION_CODE: 'WAIT_EMAIL_VERIFICATION_CODE',
  WAIT_SDS_ORG: 'WAIT_SDS_ORG',
  WAIT_SDS_DEPT: 'WAIT_SDS_DEPT',
  WAIT_SDS_FIO: 'WAIT_SDS_FIO',
  WAIT_SDS_POSITION: 'WAIT_SDS_POSITION',
  WAIT_SDS_PHONE: 'WAIT_SDS_PHONE',
  WAIT_SDS_ISSUE: 'WAIT_SDS_ISSUE',
  WAIT_SDS_APPROVAL: 'WAIT_SDS_APPROVAL'
};

const sessions = new Map();

/*
// Email verification is disabled for now.
// To enable it:
// 1. Uncomment the nodemailer import above.
// 2. Uncomment State.WAIT_EMAIL_VERIFICATION_CODE above.
// 3. In WAIT_UNLOCK_EMAIL and WAIT_NEW_USER_EMAIL handlers, replace
//    proceedAfterVerification(ctx, text) with startEmailVerification(ctx, text).
// 4. Uncomment the WAIT_EMAIL_VERIFICATION_CODE handler below.

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_PORT || '465') === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function generateEmailVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailVerificationCode(email, code) {
  await emailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Код подтверждения email',
    text: `Ваш код подтверждения: ${code}`
  });
}

async function startEmailVerification(ctx, email) {
  const maxUserId = ctx.user.user_id;
  const code = generateEmailVerificationCode();

  sessions.set(maxUserId, {
    state: State.WAIT_EMAIL_VERIFICATION_CODE,
    verificationEmail: email,
    verificationCode: code,
    verificationAttempts: 0,
    verificationExpiresAt: Date.now() + 10 * 60 * 1000
  });

  await sendEmailVerificationCode(email, code);
  await ctx.reply('Код подтверждения отправлен на email. Введите код из письма:');
}
*/

async function ensureDatabaseSchema() {
  const queries = [
    "ALTER TABLE glpi_users ADD COLUMN max_id BIGINT DEFAULT NULL",
    "ALTER TABLE glpi_users ADD COLUMN is_blocked TINYINT(1) DEFAULT 0",
    "CREATE TABLE IF NOT EXISTS blocked_max_ids (max_id BIGINT PRIMARY KEY, blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS sds_requests (id INT AUTO_INCREMENT PRIMARY KEY, max_id BIGINT, email VARCHAR(255), org VARCHAR(255), dept VARCHAR(255), fio VARCHAR(255), position VARCHAR(255), phone VARCHAR(255), issue TEXT, status VARCHAR(50) DEFAULT 'PENDING', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
  ];
  for (const sql of queries) {
    try {
      await pool.execute(sql);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_TABLE_EXISTS_ERROR') {
        console.error('DB schema error:', err.message);
      }
    }
  }
}

async function findGlpiUserByEmailOrName(email) {
  const prefix = email.split('@')[0];

  const [emailRows] = await pool.execute(
    'SELECT users_id AS id FROM glpi_useremails WHERE email = ? LIMIT 1',
    [email]
  );
  if (emailRows.length > 0) {
    return { id: emailRows[0].id };
  }

  const [nameRows] = await pool.execute(
    'SELECT id FROM glpi_users WHERE name = ? LIMIT 1',
    [prefix]
  );
  return nameRows[0] || null;
}

async function requestGlpiLdapImport(email) {
  if (!process.env.GLPI_IMPORT_URL) {
    console.error('GLPI_IMPORT_URL is not configured');
    return false;
  }

  try {
    const headers = {};
    if (process.env.GLPI_IMPORT_SECRET) {
      headers.Authorization = `Bearer ${process.env.GLPI_IMPORT_SECRET}`;
    }

    const res = await axios.post(
      process.env.GLPI_IMPORT_URL,
      { email },
      {
        headers,
        timeout: Number(process.env.GLPI_IMPORT_TIMEOUT_MS || 130000),
        validateStatus: () => true
      }
    );

    if (res.status >= 200 && res.status < 300 && res.data?.ok !== false) {
      console.log('=== GLPI CLI IMPORT REQUEST ACCEPTED ===');
      return true;
    }

    console.error('=== GLPI CLI IMPORT REQUEST FAILED ===', res.status, res.data);
    return false;
  } catch (err) {
    console.error('=== GLPI CLI IMPORT REQUEST ERROR ===', err.message);
    return false;
  }
}

async function importUserFromSdsViaGlpi(email) {
  console.log('=== IMPORT START for email:', email, '===');

  const existingUser = await findGlpiUserByEmailOrName(email);
  if (existingUser) {
    console.log('=== USER ALREADY EXISTS IN DB, id:', existingUser.id, '===');
    return existingUser;
  }

  const importRequested = await requestGlpiLdapImport(email);
  if (!importRequested) {
    console.log('=== GLPI CLI IMPORT WAS NOT STARTED ===');
    return null;
  }

  console.log('=== CHECKING DB AFTER GLPI CLI IMPORT ===');
  const attempts = Number(process.env.GLPI_IMPORT_CHECK_ATTEMPTS || 10);
  const delayMs = Number(process.env.GLPI_IMPORT_CHECK_DELAY_MS || 1500);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await new Promise(r => setTimeout(r, delayMs));

    const user = await findGlpiUserByEmailOrName(email);
    if (user) {
      console.log('=== USER FOUND IN DB AFTER IMPORT, id:', user.id, 'attempt:', attempt, '===');
      return user;
    }
  }

  const [recent] = await pool.execute(
    'SELECT id, name, realname, date_mod FROM glpi_users ORDER BY id DESC LIMIT 5'
  );
  console.log('=== USER NOT FOUND AFTER CLI IMPORT, LAST 5 USERS FOR DEBUG ===');
  console.table(recent);
  return null;
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
    'INSERT INTO blocked_max_ids (max_id, blocked_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE blocked_at=NOW()',
    [maxUserId]
  );
}

async function unblockMaxId(maxUserId) {
  await pool.execute('DELETE FROM blocked_max_ids WHERE max_id = ?', [maxUserId]);
}

async function findGlpiUserByMaxId(maxUserId) {
  const [rows] = await pool.execute(
    'SELECT id, name, realname, firstname FROM glpi_users WHERE max_id = ? AND is_active = 1 LIMIT 1',
    [maxUserId]
  );
  return rows[0] || null;
}

async function linkMaxIdToGlpiUser(glpiUserId, maxUserId) {
  await pool.execute(
    'UPDATE glpi_users SET max_id = ?, is_blocked = 0, is_active = 1 WHERE id = ?',
    [maxUserId, glpiUserId]
  );
}

async function createSdsRequest(maxUserId, email, data) {
  await pool.execute(
    'INSERT INTO sds_requests (max_id, email, org, dept, fio, position, phone, issue, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "PENDING")',
    [maxUserId, email, data.org, data.dept, data.fio, data.position, data.phone, data.issue]
  );
}

const mainMenuKeyboard = () => Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Новая', 'menu:new')],
  [Keyboard.button.callback('Выбрать', 'menu:list')],
  [Keyboard.button.callback('Справка', 'menu:help')],
  [Keyboard.button.callback('Выйти', 'menu:logout', { intent: 'negative' })],
]);

async function showWelcomeAndMenu(ctx, user) {
  const maxUserId = ctx.user.user_id;
  sessions.set(maxUserId, { state: State.IDLE, glpiUserId: user.id });
  const fio = ((user.firstname || '') + ' ' + (user.realname || '')).trim() || user.name;
  await ctx.reply('Добро пожаловать, ' + fio + '!', { attachments: [mainMenuKeyboard()] });
}

async function proceedAfterVerification(ctx, verifiedEmail) {
  const maxUserId = ctx.user.user_id;

  await ctx.reply('Проверка наличия в SDS-helpdesk...');

  const importResult = await importUserFromSdsViaGlpi(verifiedEmail);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId);
    const user = await findGlpiUserByMaxId(maxUserId);
    if (user) {
      await ctx.reply('Учетная запись найдена в SDS и успешно привязана.');
      await showWelcomeAndMenu(ctx, user);
      return;
    }
  }

  sessions.set(maxUserId, {
    state: State.WAIT_SDS_ORG,
    verifiedEmail: verifiedEmail,
    sdsData: {}
  });
  await ctx.reply('Пользователь отсутствует в SDS-helpdesk. Начинаем процесс регистрации.');
  await ctx.reply('Введите название организации:');
}

async function entryPoint(ctx) {
  const maxUserId = ctx.user.user_id;
  await ctx.reply('Приглашение войти. Проверка доступа...');

  try {
    const blocked = await isMaxIdBlocked(maxUserId);
    if (blocked) {
      sessions.set(maxUserId, { state: State.WAIT_UNLOCK_EMAIL, attempts: 0 });
      await ctx.reply('Ваш ID заблокирован, необходима разблокировка.');
      await ctx.reply('Введите ваш корпоративный email:');
      return;
    }

    const user = await findGlpiUserByMaxId(maxUserId);
    if (user) {
      await showWelcomeAndMenu(ctx, user);
      return;
    }

    sessions.set(maxUserId, { state: State.WAIT_NEW_USER_EMAIL });
    await ctx.reply('Ваш MAX ID не найден в системе GLPI.');
    await ctx.reply('Введите ваш корпоративный email для привязки учетной записи:');
  } catch (error) {
    console.error('entryPoint error:', error);
    await ctx.reply('Ошибка подключения к базе данных.');
  }
}

bot.on('bot_started', async (ctx) => { await entryPoint(ctx); });
bot.command('start', async (ctx) => { await entryPoint(ctx); });

bot.on('message_created', async (ctx) => {
  if (!ctx.message || !ctx.message.body || !ctx.message.body.text) return;
  if (!ctx.user || !ctx.user.user_id) return;

  const maxUserId = ctx.user.user_id;
  const session = sessions.get(maxUserId);
  if (!session) return;

  const text = ctx.message.body.text.trim();

  try {
    if (session.state === State.WAIT_UNLOCK_EMAIL) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await ctx.reply('Некорректный формат email. Попробуйте снова:');
        return;
      }
      session.state = State.IDLE;
      sessions.set(maxUserId, session);
      // await startEmailVerification(ctx, text);
      await proceedAfterVerification(ctx, text);
    } else if (session.state === State.WAIT_NEW_USER_EMAIL) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await ctx.reply('Некорректный формат email. Попробуйте снова:');
        return;
      }
      session.state = State.IDLE;
      sessions.set(maxUserId, session);
      // await startEmailVerification(ctx, text);
      await proceedAfterVerification(ctx, text);
    /*
    } else if (session.state === State.WAIT_EMAIL_VERIFICATION_CODE) {
      if (Date.now() > session.verificationExpiresAt) {
        sessions.set(maxUserId, { state: State.WAIT_NEW_USER_EMAIL });
        await ctx.reply('Срок действия кода истек. Введите email заново:');
        return;
      }

      if (text !== session.verificationCode) {
        session.verificationAttempts = (session.verificationAttempts || 0) + 1;

        if (session.verificationAttempts >= 2) {
          await blockMaxId(maxUserId);
          sessions.delete(maxUserId);
          await ctx.reply('Код введен неверно два раза. Ваш MAX ID заблокирован.');
          return;
        }

        sessions.set(maxUserId, session);
        await ctx.reply('Код неверный. Попробуйте еще раз:');
        return;
      }

      await unblockMaxId(maxUserId);
      const verifiedEmail = session.verificationEmail;
      session.state = State.IDLE;
      sessions.set(maxUserId, session);
      await proceedAfterVerification(ctx, verifiedEmail);
    */
    } else if (session.state === State.WAIT_SDS_ORG) {
      session.sdsData.org = text;
      session.state = State.WAIT_SDS_DEPT;
      sessions.set(maxUserId, session);
      await ctx.reply('Введите подразделение:');
    } else if (session.state === State.WAIT_SDS_DEPT) {
      session.sdsData.dept = text;
      session.state = State.WAIT_SDS_FIO;
      sessions.set(maxUserId, session);
      await ctx.reply('Введите ФИО полностью:');
    } else if (session.state === State.WAIT_SDS_FIO) {
      session.sdsData.fio = text;
      session.state = State.WAIT_SDS_POSITION;
      sessions.set(maxUserId, session);
      await ctx.reply('Введите должность:');
    } else if (session.state === State.WAIT_SDS_POSITION) {
      session.sdsData.position = text;
      session.state = State.WAIT_SDS_PHONE;
      sessions.set(maxUserId, session);
      await ctx.reply('Введите телефон:');
    } else if (session.state === State.WAIT_SDS_PHONE) {
      session.sdsData.phone = text;
      session.state = State.WAIT_SDS_ISSUE;
      sessions.set(maxUserId, session);
      await ctx.reply('Опишите содержание обращения:');
    } else if (session.state === State.WAIT_SDS_ISSUE) {
      session.sdsData.issue = text;
      await createSdsRequest(maxUserId, session.verifiedEmail, session.sdsData);
      session.state = State.WAIT_SDS_APPROVAL;
      sessions.set(maxUserId, session);
      await ctx.reply('Данные переданы администраторам. С вами свяжутся.');
      await ctx.reply('Ожидайте подтверждения заявки на добавление в SDS-helpdesk.');
    } else if (session.state === State.WAIT_SDS_APPROVAL) {
      await ctx.reply('Заявка находится на рассмотрении администраторов.');
    } else {
      await ctx.reply('Используйте меню или отправьте /start.');
    }
  } catch (error) {
    console.error('message_created error:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('menu:new', (ctx) => ctx.reply('Функционал создания заявки будет добавлен на следующем этапе.'));
bot.action('menu:list', (ctx) => ctx.reply('Функционал списка заявок будет добавлен на следующем этапе.'));
bot.action('menu:help', (ctx) => ctx.reply('Бот для работы с заявками GLPI. Используйте кнопки меню для навигации.'));
bot.action('menu:logout', (ctx) => {
  if (ctx.user && ctx.user.user_id) {
    sessions.delete(ctx.user.user_id);
  }
  ctx.reply('Сессия завершена. Отправьте /start для входа.');
});

const webhookServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/sds-approval') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { maxUserId, status } = JSON.parse(body);
        const [requests] = await pool.execute(
          'SELECT email FROM sds_requests WHERE max_id = ? AND status = "PENDING" ORDER BY id DESC LIMIT 1',
          [maxUserId]
        );
        await pool.execute(
          'UPDATE sds_requests SET status = ? WHERE max_id = ? AND status = "PENDING" ORDER BY id DESC LIMIT 1',
          [status === 'APPROVED' ? 'APPROVED' : 'REJECTED', maxUserId]
        );
        if (status === 'APPROVED' && requests.length > 0) {
          const email = requests[0].email;
          await bot.api.sendMessageToUser(maxUserId, 'Заявка одобрена. Учетная запись в SDS создана.');
          const importResult = await importUserFromSdsViaGlpi(email);
          if (importResult && importResult.id) {
            await linkMaxIdToGlpiUser(importResult.id, maxUserId);
          }
          const user = await findGlpiUserByMaxId(maxUserId);
          if (user) {
            const fakeCtx = { user: { user_id: maxUserId }, reply: (t, o) => bot.api.sendMessageToUser(maxUserId, t, o) };
            await showWelcomeAndMenu(fakeCtx, user);
          }
        } else {
          sessions.delete(maxUserId);
          await bot.api.sendMessageToUser(maxUserId, 'Заявка отклонена. Обратитесь к администратору.');
        }
        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

async function startApp() {
  await ensureDatabaseSchema();
  bot.start();
  webhookServer.listen(PORT, () => {
    console.log('Бот запущен. Webhook: http://localhost:' + PORT + '/webhook/sds-approval');
  });
}

startApp();

process.on('SIGINT', async () => {
  console.log('Завершение работы...');
  await pool.end();
  process.exit(0);
});
