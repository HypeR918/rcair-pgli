// =====================================================================
// MAX ITSM BOT (GLPI Native DB + REST API + SMTP)
// =====================================================================
import { Bot, Keyboard } from '@maxhub/max-bot-api';
import http from 'node:http';
import mysql from 'mysql2/promise';
import nodemailer from 'nodemailer';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import 'dotenv/config';

const bot = new Bot(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const proxyAgent = process.env.PROXY_URL ? new SocksProxyAgent(process.env.PROXY_URL) : undefined;

// =====================================================================
// 1. ИНТЕГРАЦИИ (GLPI DB, SMTP, GLPI REST API)
// =====================================================================

class GlpiDbService {
  constructor() {
    this.pool = mysql.createPool({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME, charset: 'utf8mb4',
      waitForConnections: true, connectionLimit: 10,
    });
  }

  // ⚠️ ВНИМАНИЕ: Здесь мы ищем MAX ID в поле `registration_number`. 
  // Если ваши админы GLPI пишут MAX ID в другое поле (например, `phone` или кастомное), замените название колонки в SQL.
  async findUserByMaxId(maxUserId) {
    const [rows] = await this.pool.execute(
      `SELECT id, name, realname, firstname, is_active, is_deleted 
       FROM glpi_users 
       WHERE registration_number = ? LIMIT 1`,
      [String(maxUserId)]
    );
    return rows[0] || null;
  }

  // Разблокировка (Ставим is_active = 1)
  async unblockUser(glpiUserId) {
    await this.pool.execute(
      'UPDATE glpi_users SET is_active = 1, is_deleted = 0 WHERE id = ?',
      [glpiUserId]
    );
  }

  // Блокировка при неудачных попытках ввода кода (Ставим is_active = 0)
  async blockUserByMaxId(maxUserId) {
    await this.pool.execute(
      'UPDATE glpi_users SET is_active = 0 WHERE registration_number = ?',
      [String(maxUserId)]
    );
  }
  
  async close() { await this.pool.end(); }
}

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT), secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  async sendCode(email, code) {
    try {
      await this.transporter.sendMail({
        from: `"ITSM Bot" <${process.env.SMTP_USER}>`, to: email,
        subject: 'Код верификации MAX Bot',
        html: `<p>Ваш код подтверждения: <b>${code}</b></p>`,
      });
      return true;
    } catch (e) { console.error('[SMTP]', e.message); return false; }
  }
}

class GlpiApiService {
  constructor() {
    this.sessionToken = null;
    this.client = axios.create({
      baseURL: process.env.GLPI_API_URL,
      headers: { 'App-Token': process.env.GLPI_APP_TOKEN, 'Content-Type': 'application/json' },
      httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false, timeout: 15000
    });
  }

  async initSession() {
    if (this.sessionToken) return this.sessionToken;
    const res = await this.client.get('/initSession', { params: { user_token: process.env.GLPI_USER_TOKEN } });
    this.sessionToken = res.data.session_token;
    this.client.defaults.headers.common['Session-Token'] = this.sessionToken;
    return this.sessionToken;
  }

  async createTicket(glpiUserId, subject, content) {
    await this.initSession();
    const res = await this.client.post('/Ticket', {
      input: { 
        name: subject, content: content, status: 1, urgency: 3,
        _users_id_requester: glpiUserId // Привязываем заявку к пользователю GLPI
      }
    });
    return res.data;
  }
}

const db = new GlpiDbService();
const emailService = new EmailService();
const glpiApi = new GlpiApiService();

// =====================================================================
// 2. FSM (State Machine)
// =====================================================================
const State = {
  IDLE: 'IDLE', WAIT_EMAIL: 'WAIT_EMAIL', WAIT_CODE: 'WAIT_CODE',
  SDS_FIO: 'SDS_FIO', SDS_DEPT: 'SDS_DEPT', SDS_ORG: 'SDS_ORG', SDS_PHONE: 'SDS_PHONE', SDS_ISSUE: 'SDS_ISSUE',
  WAIT_NEW_TICKET: 'WAIT_NEW_TICKET'
};

const sessions = new Map();
const getSession = (userId) => {
  if (!sessions.has(userId)) sessions.set(userId, { userId, state: State.IDLE, attempts: 0, sdsData: {} });
  return sessions.get(userId);
};
const setState = (userId, state, patch = {}) => Object.assign(getSession(userId), patch, { state });

// =====================================================================
// 3. КЛАВИАТУРЫ И БИЗНЕС-ЛОГИКА
// =====================================================================
const KB = {
  mainMenu: () => Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🆕 Новая заявка', 'menu:new')],
    [Keyboard.button.callback('📋 Мои заявки', 'menu:list')],
    [Keyboard.button.callback('🚪 Выйти', 'menu:logout', { intent: 'negative' })],
  ]),
};

async function entryPoint(ctx) {
  const maxUserId = ctx.user.user_id;
  await ctx.reply('🔐 *Поиск учетной записи в GLPI...*', { format: 'markdown' });

  const glpiUser = await db.findUserByMaxId(maxUserId);

  if (!glpiUser) {
    // Пользователя нет в БД GLPI -> Нужна регистрация в SDS
    await ctx.reply('⚠ *Вы не найдены в базе GLPI (SDS).*\nНачинаем процесс регистрации.\n\n📧 Введите корпоративный Email:');
    return setState(maxUserId, State.WAIT_EMAIL, { action: 'register' });
  }

  if (glpiUser.is_active === 0 || glpiUser.is_deleted === 1) {
    // Пользователь найден, но заблокирован в GLPI -> Нужна разблокировка
    await ctx.reply('⛔ *Ваша учетная запись в GLPI заблокирована.*\nДля разблокировки подтвердите Email.\n\n📧 Введите email:');
    return setState(maxUserId, State.WAIT_EMAIL, { action: 'unblock', glpiUserId: glpiUser.id });
  }

  // Пользователь активен -> Главное меню
  const fio = `${glpiUser.firstname || ''} ${glpiUser.realname || ''}`.trim() || glpiUser.name;
  setState(maxUserId, State.IDLE, { glpiUserId: glpiUser.id, fio });
  await showMainMenu(ctx);
}

async function showMainMenu(ctx) {
  const s = getSession(ctx.user.user_id);
  await ctx.reply(`✅ *Главное меню*\nДобро пожаловать, ${s.fio || 'коллега'}!`, { 
    format: 'markdown', attachments: [KB.mainMenu()] 
  });
}

async function handleEmail(ctx, text) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return ctx.reply('❌ Некорректный email.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const sent = await emailService.sendCode(text, code);
  if (!sent) return ctx.reply('⚠ Ошибка отправки письма.');
  
  setState(ctx.user.user_id, State.WAIT_CODE, { email: text, code, attempts: 0 });
  await ctx.reply('📩 Код отправлен. Введите 6-значный код:');
}

async function handleCode(ctx, text) {
  const s = getSession(ctx.user.user_id);
  if (text === s.code) {
    if (s.action === 'unblock') {
      await db.unblockUser(s.glpiUserId);
      await ctx.reply('✅ *Учетная запись разблокирована!*', { format: 'markdown' });
    } else if (s.action === 'register') {
      return startSdsRegistration(ctx); // Переход к сбору данных для LDAP
    }
    setState(ctx.user.user_id, State.IDLE);
    // Повторно запускаем entryPoint, чтобы подтянуть свежие данные из БД и показать меню
    return entryPoint(ctx); 
  }
  
  s.attempts++;
  if (s.attempts >= 2) {
    // Если пользователь уже был в БД (но заблокирован), мы гарантируем, что он останется заблокированным
    if (s.action === 'unblock') await db.blockUserByMaxId(ctx.user.user_id);
    sessions.delete(ctx.user.user_id);
    return ctx.reply('🚫 *Превышено число попыток. Доступ запрещен.*\nОбратитесь к администратору.', { format: 'markdown' });
  }
  await ctx.reply(`❌ Неверно. Осталось попыток: ${2 - s.attempts}`);
}

async function startSdsRegistration(ctx) {
  setState(ctx.user.user_id, State.SDS_FIO);
  await ctx.reply('👤 *Регистрация в SDS*\n\n1/5. Введите ФИО полностью:');
}

async function handleSdsStep(ctx, text) {
  const s = getSession(ctx.user.user_id);
  switch (s.state) {
    case State.SDS_FIO: s.sdsData.fio = text; setState(s.userId, State.SDS_ORG); return ctx.reply('2/5. Введите Организацию:');
    case State.SDS_ORG: s.sdsData.org = text; setState(s.userId, State.SDS_DEPT); return ctx.reply('3/5. Введите Подразделение:');
    case State.SDS_DEPT: s.sdsData.dept = text; setState(s.userId, State.SDS_PHONE); return ctx.reply('4/5. Введите Телефон:');
    case State.SDS_PHONE: s.sdsData.phone = text; setState(s.userId, State.SDS_ISSUE); return ctx.reply('5/5. Опишите кратко суть обращения:');
    case State.SDS_ISSUE:
      s.sdsData.issue = text;
      // Здесь вызов LDAP / Создание заявки на онбординг
      setState(s.userId, State.IDLE); 
      return ctx.reply('⏳ *Данные переданы администраторам SDS.*\nОжидайте подтверждения.', { format: 'markdown' });
  }
}

// =====================================================================
// 4. РОУТЕРЫ MAX BOT API
// =====================================================================
bot.command('start', (ctx) => entryPoint(ctx));
bot.action('menu:new', (ctx) => { setState(ctx.user.user_id, State.WAIT_NEW_TICKET); ctx.reply('📝 Опишите проблему одним сообщением:'); });
bot.action('menu:logout', (ctx) => { sessions.delete(ctx.user.user_id); ctx.reply('👋 Сессия завершена. /start — чтобы войти.'); });
bot.action('menu:list', async (ctx) => { ctx.reply('📋 Список заявок (в разработке, используйте веб-интерфейс GLPI).'); });

bot.on('message_created', async (ctx) => {
  if (!ctx.user || !ctx.message?.body?.text) return;
  const userId = ctx.user.user_id;
  const s = getSession(userId);
  const text = ctx.message.body.text.trim();

  try {
    switch (s.state) {
      case State.WAIT_EMAIL: return handleEmail(ctx, text);
      case State.WAIT_CODE: return handleCode(ctx, text);
      case State.SDS_FIO: case State.SDS_ORG: case State.SDS_DEPT: case State.SDS_PHONE: case State.SDS_ISSUE: 
        return handleSdsStep(ctx, text);
      case State.WAIT_NEW_TICKET: {
        if (!s.glpiUserId) return ctx.reply('Ошибка сессии. Отправьте /start');
        const t = await glpiApi.createTicket(s.glpiUserId, text.slice(0, 80), text);
        setState(userId, State.IDLE);
        await ctx.reply(`✅ *Заявка #${t.id} создана в GLPI!*`, { format: 'markdown', attachments: [KB.mainMenu()] });
        return;
      }
      default: return ctx.reply('Используйте меню или отправьте /start');
    }
  } catch (e) {
    console.error(e);
    ctx.reply('⚠ Внутренняя ошибка. Попробуйте позже.');
  }
});

// =====================================================================
// 5. HTTP-СЕРВЕР (Webhooks)
// =====================================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/sds-approval') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { userId, status } = JSON.parse(body);
        if (status === 'APPROVED') {
          await bot.api.sendMessageToUser(userId, '🎉 *Учетная запись SDS создана и синхронизирована с GLPI!*', { format: 'markdown' });
          const fakeCtx = { user: { user_id: userId }, reply: (t, o) => bot.api.sendMessageToUser(userId, t, o) };
          entryPoint(fakeCtx);
        }
        res.writeHead(200); res.end('OK');
      } catch (e) { res.writeHead(400); res.end('Bad request'); }
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

bot.start();
server.listen(PORT, () => console.log(`🚀 Бот запущен. Webhook: http://localhost:${PORT}/webhook/sds-approval`));
process.on('SIGINT', async () => { await db.close(); process.exit(0); });