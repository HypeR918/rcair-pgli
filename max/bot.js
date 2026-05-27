import { Bot, Keyboard } from '@maxhub/max-bot-api';
import mysql from 'mysql2/promise';
import axios from 'axios';
import http from 'node:http';
import fs from 'node:fs';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
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

const glpiClient = axios.create({
  baseURL: process.env.GLPI_API_URL,
  headers: {
    'App-Token': process.env.GLPI_APP_TOKEN,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

const glpiWebClient = wrapper(axios.create({
  baseURL: process.env.GLPI_WEB_URL || process.env.GLPI_API_URL.replace('/apirest.php', ''),
  jar: new CookieJar(),
  withCredentials: true,
  timeout: 30000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0'
  }
}));

let glpiSessionToken = null;

const State = {
  IDLE: 'IDLE',
  WAIT_UNLOCK_EMAIL: 'WAIT_UNLOCK_EMAIL',
  WAIT_NEW_USER_EMAIL: 'WAIT_NEW_USER_EMAIL',
  WAIT_SDS_ORG: 'WAIT_SDS_ORG',
  WAIT_SDS_DEPT: 'WAIT_SDS_DEPT',
  WAIT_SDS_FIO: 'WAIT_SDS_FIO',
  WAIT_SDS_POSITION: 'WAIT_SDS_POSITION',
  WAIT_SDS_PHONE: 'WAIT_SDS_PHONE',
  WAIT_SDS_ISSUE: 'WAIT_SDS_ISSUE',
  WAIT_SDS_APPROVAL: 'WAIT_SDS_APPROVAL'
};

const sessions = new Map();

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

async function initGlpiSession() {
  if (glpiSessionToken) return glpiSessionToken;
  const res = await glpiClient.get('/initSession', {
    params: { user_token: process.env.GLPI_USER_TOKEN }
  });
  glpiSessionToken = res.data.session_token;
  glpiClient.defaults.headers.common['Session-Token'] = glpiSessionToken;
  return glpiSessionToken;
}

async function loginToGlpiWeb() {
  try {
    const loginPage = await glpiWebClient.get('/index.php');
    const csrfMatch = loginPage.data.match(/name="_glpi_csrf_token"\s+value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    const loginRes = await glpiWebClient.post('/front/login.php', new URLSearchParams({
      login_name: process.env.GLPI_WEB_USER || 'glpi',
      login_password: process.env.GLPI_WEB_PASS || 'glpi',
      submit: 'Send',
      _glpi_csrf_token: csrf
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 5,
      validateStatus: () => true
    });

    const isLoggedIn = loginRes.data && (
      loginRes.data.includes('logout') ||
      loginRes.data.includes('central.php') ||
      !loginRes.data.includes('login_name')
    );
    console.log('[GLPI Login] Success:', isLoggedIn);
    return isLoggedIn;
  } catch (err) {
    console.error('[GLPI Login] Error:', err.message);
    return false;
  }
}

async function searchUserInLdapViaGlpi(email) {
  const loggedIn = await loginToGlpiWeb();
  if (!loggedIn) return { found: false };

  const ldapServerId = process.env.GLPI_LDAP_SERVER_ID || 1;

  try {
    console.log('[LDAP Search] Step 1: Loading search form');

    const formPage = await glpiWebClient.get('/front/ldap.import.php', {
      params: { authldaps_id: ldapServerId },
      maxRedirects: 5,
      validateStatus: () => true
    });

    const formHtml = formPage.data || '';
    const csrfMatch = formHtml.match(/name="_glpi_csrf_token"\s+value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    if (!csrf) {
      console.error('[LDAP Search] CSRF token not found');
      return { found: false };
    }

    console.log('[LDAP Search] Step 2: Submitting search via GET');

    const searchParams = new URLSearchParams();
    searchParams.append('authldaps_id', String(ldapServerId));
    searchParams.append('entities_id', '0');
    searchParams.append('interface', 'simple');
    searchParams.append('criterias[email1_field]', email);
    searchParams.append('action', 'show');
    searchParams.append('mode', '0');
    searchParams.append('_in_modal', '0');
    searchParams.append('search', '1');
    searchParams.append('_glpi_csrf_token', csrf);

    const searchUrl = '/front/ldap.import.php?' + searchParams.toString();

    const searchPage = await glpiWebClient.get(searchUrl, {
      maxRedirects: 5,
      validateStatus: () => true
    });

    const html = searchPage.data || '';
    fs.writeFileSync('glpi_debug_search.html', html, 'utf8');
    console.log('[LDAP Search] Response length:', html.length);

    const emailFound = html.includes(email) || html.includes(email.split('@')[0]);
    console.log('[LDAP Search] Email or username found in HTML:', emailFound);

    const containerMatch = html.match(/id="(massAuthLDAP\d+)"/);
    const container = containerMatch ? containerMatch[1] : null;
    console.log('[LDAP Search] Container ID:', container);

    const userMatches = [...html.matchAll(/data-itemtype="AuthLDAP"\s+data-id="([^"]+)"/gi)];
    console.log('[LDAP Search] Users found:', userMatches.length);

    if (userMatches.length > 0 && container) {
      const samaccountname = userMatches[0][1];
      console.log('[LDAP Search] Found user:', samaccountname);

      const csrfMatch2 = html.match(/name="_glpi_csrf_token"\s+value="([^"]+)"/);
      const csrf2 = csrfMatch2 ? csrfMatch2[1] : csrf;

      return {
        found: true,
        samaccountname: samaccountname,
        ldapServerId: ldapServerId,
        csrf: csrf2,
        container: container
      };
    }

    if (/0\s+(?:пользователь|user|utilisateur)/i.test(html) ||
        /не\s+найдено|no\s+results|aucun/i.test(html)) {
      console.log('[LDAP Search] Explicit "not found" message');
      return { found: false };
    }

    console.log('[LDAP Search] No users found in HTML');
    return { found: false };
  } catch (err) {
    console.error('[LDAP Search] Exception:', err.message);
    return { found: false };
  }
}

async function importFoundUserViaGlpi(samaccountname, ldapServerId, csrf, container) {
  try {
    const origin = process.env.GLPI_WEB_URL || process.env.GLPI_API_URL.replace('/apirest.php', '');
    const referer = origin + '/front/ldap.import.php';

    // ============ ШАГ 3: Открыть модалку "Действия" ============
    // Эмулируем: пользователь поставил галочку и нажал "Действия"
    // JS в HTML: el.find('.modal-body').load('/ajax/massiveaction.php', fields)
    // fields = { authldaps_id, mode, massive_action_fields[0,1], container, specific_actions, item[AuthLDAP][name] }
    // ВАЖНО: massiveaction НЕ передаётся — он появится только после выбора из dropdown
    console.log('[LDAP Import] Step 3: Opening Actions modal for:', samaccountname);

    const step3Params = new URLSearchParams();
    step3Params.append('authldaps_id', String(ldapServerId));
    step3Params.append('mode', '0');
    step3Params.append('massive_action_fields[0]', 'authldaps_id');
    step3Params.append('massive_action_fields[1]', 'mode');
    step3Params.append('container', container);
    step3Params.append('specific_actions[AuthLDAP:import]', 'Импорт');
    step3Params.append(`item[AuthLDAP][${samaccountname}]`, '1');

    const step3Res = await glpiWebClient.post('/ajax/massiveaction.php', step3Params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Glpi-Csrf-Token': csrf,
        'Accept': '*/*',
        'Referer': referer,
        'Origin': origin
      },
      maxRedirects: 5,
      validateStatus: () => true
    });

    console.log('[LDAP Import] Step 3 status:', step3Res.status, 'length:', (step3Res.data || '').length);
    const step3Html = String(step3Res.data || '');
    fs.writeFileSync('glpi_debug_step3_modal.html', step3Html, 'utf8');

    if (step3Res.status === 403) {
      console.error('[LDAP Import] 403 on modal open');
      return false;
    }

    // ============ ШАГ 5-6: Парсим форму модалки и отправляем финальный submit ============
    // Эмулируем: пользователь выбрал "Импорт" в dropdown и нажал "Отправить"
    // Форма в модалке имеет action="/front/massiveaction.php"
    // Все её поля (hidden + select) + massiveaction=AuthLDAP:import + csrf
    
    console.log('[LDAP Import] Step 5: Parsing modal form');

    const finalParams = new URLSearchParams();

    // Собираем все input элементы из модалки
    const allInputs = [...step3Html.matchAll(/<input[^>]*>/gi)];
    for (const input of allInputs) {
      const tag = input[0];
      const nameMatch = tag.match(/name=['"]([^'"]+)['"]/i);
      const valueMatch = tag.match(/value=['"]([^'"]*)['"]/i);
      const typeMatch = tag.match(/type=['"]([^'"]+)['"]/i);

      if (nameMatch) {
        const name = nameMatch[1];
        const type = typeMatch ? typeMatch[1].toLowerCase() : 'text';
        const value = valueMatch ? valueMatch[1] : '';

        if (type === 'checkbox') {
          if (tag.includes('checked')) finalParams.append(name, value || '1');
        } else if (type !== 'submit' && type !== 'button') {
          finalParams.append(name, value);
        }
      }
    }

    // Select элементы (dropdown с действием — ключевой!)
    const selects = [...step3Html.matchAll(/<select[^>]*name=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/select>/gi)];
    for (const sel of selects) {
      const selectName = sel[1];
      const optionsHtml = sel[2];
      // Берём значение выбранного option (для massiveaction это будет -1 по умолчанию, но мы перезапишем)
      const selectedMatch = optionsHtml.match(/<option[^>]*selected[^>]*value=['"]([^'"]*)['"]/i);
      if (selectedMatch) {
        finalParams.append(selectName, selectedMatch[1]);
      }
    }

    // Извлекаем CSRF из модалки
    const csrfInModal = step3Html.match(/name=['"]_glpi_csrf_token['"][^>]*value=['"]([^'"]+)['"]/i) ||
                        step3Html.match(/value=['"]([^'"]+)['"][^>]*name=['"]_glpi_csrf_token['"]/i);
    const csrfFinal = csrfInModal ? csrfInModal[1] : csrf;

    // Перезаписываем ключевые поля (эмулируем выбор "Импорт" из dropdown)
    finalParams.set('massiveaction', 'AuthLDAP:import');
    finalParams.set(`item[AuthLDAP][${samaccountname}]`, '1');
    finalParams.set('_glpi_csrf_token', csrfFinal);

    console.log('[LDAP Import] Final params count:', [...finalParams.keys()].length);
    console.log('[LDAP Import] Final params keys:', [...finalParams.keys()].join(', '));

    // ============ ШАГ 6: Финальный POST на /front/massiveaction.php ============
    // Эмулируем: пользователь нажал кнопку "Отправить"
    console.log('[LDAP Import] Step 6: Submitting to /front/massiveaction.php');
    console.log('[LDAP Import] Body:', finalParams.toString());

    const step6Res = await glpiWebClient.post('/front/massiveaction.php', finalParams.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': referer,
        'Origin': origin
      },
      maxRedirects: 5,
      validateStatus: () => true
    });

    console.log('[LDAP Import] Step 6 status:', step6Res.status, 'length:', (step6Res.data || '').length);
    const step6Html = String(step6Res.data || '');
    fs.writeFileSync('glpi_debug_step6_result.html', step6Html, 'utf8');

    // ============ ПРОВЕРКА РЕЗУЛЬТАТА ============
    if (/<title>[^<]*Ошибка[^<]*<\/title>/i.test(step6Html) ||
        /<h1[^>]*>[^<]*Ошибка[^<]*<\/h1>/i.test(step6Html)) {
      console.error('[LDAP Import] ERROR PAGE DETECTED');
      const errorTitle = step6Html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
      const errorBody = step6Html.match(/<div[^>]*class=['"][^'"]*alert[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i);
      if (errorTitle) console.error('[LDAP Import] Error title:', errorTitle[1]);
      if (errorBody) console.error('[LDAP Import] Error body:', errorBody[1].replace(/<[^>]+>/g, ' ').trim().substring(0, 500));
      return false;
    }

    if (step6Html.includes('"ok":true') || step6Html.includes('"ok": true')) {
      console.log('[LDAP Import] SUCCESS (JSON ok:true)');
      return true;
    }

    const successPatterns = [
      /importé\s+avec\s+succès/i,
      /successfully\s+imported/i,
      /успешно\s+импортирован/i,
      /1\s+utilisateur\s+importé/i,
      /1\s+user\s+imported/i,
      /1\s+пользователь\s+импортирован/i,
      /1\s+элемент\s+обновл/i,
      /операция\s+выполнена/i,
      /Ok\s*-\s*1/i,
      /импорт\s+выполнен/i
    ];

    for (const pattern of successPatterns) {
      if (pattern.test(step6Html)) {
        console.log('[LDAP Import] SUCCESS (pattern matched)');
        return true;
      }
    }

    // Если вернулся полный HTML страницы (редирект после импорта) — считаем успехом
    if (step6Res.status === 200 && step6Html.length > 50000) {
      console.log('[LDAP Import] SUCCESS (assumed: full page redirect after import)');
      return true;
    }

    console.log('[LDAP Import] First 1500 chars of response:');
    console.log(step6Html.substring(0, 1500));
    return false;
  } catch (err) {
    console.error('[LDAP Import] Exception:', err.message);
    return false;
  }
}

async function importUserFromSdsViaGlpi(email) {
  console.log('=== IMPORT START for email:', email, '===');

  const prefix = email.split('@')[0];
  let [existingRows] = await pool.execute(
    'SELECT id FROM glpi_users WHERE name = ? LIMIT 1',
    [prefix]
  );
  if (existingRows.length > 0) {
    console.log('=== USER ALREADY EXISTS IN DB, id:', existingRows[0].id, '===');
    return { id: existingRows[0].id };
  }

  const search = await searchUserInLdapViaGlpi(email);
  console.log('=== SEARCH RESULT:', JSON.stringify(search, null, 2), '===');

  if (!search.found) {
    console.log('=== USER NOT FOUND IN SDS ===');
    return null;
  }

  console.log('=== FOUND USER, starting import ===');

  const imported = await importFoundUserViaGlpi(
    search.samaccountname,
    search.ldapServerId,
    search.csrf,
    search.container
  );

  console.log('=== CHECKING DB ===');

  await new Promise(r => setTimeout(r, 1000));

  let [rows] = await pool.execute(
    'SELECT id FROM glpi_users WHERE name = ? LIMIT 1',
    [search.samaccountname]
  );

  if (rows.length > 0) {
    console.log('=== USER FOUND IN DB:', rows[0].id, '===');
    return { id: rows[0].id };
  }

  const [emailRows] = await pool.execute(
    'SELECT users_id AS id FROM glpi_useremails WHERE email = ? LIMIT 1',
    [email]
  );

  if (emailRows.length > 0) {
    console.log('=== USER ID (via email):', emailRows[0].id, '===');
    return { id: emailRows[0].id };
  }

  const [recent] = await pool.execute(
    'SELECT id, name, realname, date_mod FROM glpi_users ORDER BY id DESC LIMIT 5'
  );
  console.log('=== LAST 5 USERS (for debug) ===');
  console.table(recent);

  if (!imported) {
    console.log('=== IMPORT FAILED AND USER NOT IN DB ===');
    return null;
  }

  console.log('=== IMPORT REPORTED SUCCESS BUT USER NOT FOUND IN DB ===');
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
      await proceedAfterVerification(ctx, text);
    } else if (session.state === State.WAIT_NEW_USER_EMAIL) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await ctx.reply('Некорректный формат email. Попробуйте снова:');
        return;
      }
      session.state = State.IDLE;
      sessions.set(maxUserId, session);
      await proceedAfterVerification(ctx, text);
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