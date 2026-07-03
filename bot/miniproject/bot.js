import http from 'node:http';
import https from 'node:https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BOT_TOKEN = 'f9LHodD0cOIV4Kmc8qRG4gHpkAajrP_qH7jf5l5oT-ci6bEQi18ted72hb3JiC2e7BWnLrqckCMowpJO8wB1';
const MINI_APP_URL = 'https://ereestrservisov.gov70.ru';

const API = 'https://platform-api2.max.ru';

async function api(method, path, body = null) {
  const url = `${API}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': BOT_TOKEN,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    console.error(`API ${method} ${path}: ${res.status}`, data);
  }

  return data;
}

async function getUpdates(lastEventId = null) {
  const params = lastEventId ? `?lastEventId=${lastEventId}` : '';
  const url = `${API}/updates${params}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': BOT_TOKEN },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { updates: [] }; }
}

async function sendMessage(chatId, text, keyboard = null) {
  const body = { text };

  if (keyboard) {
    body.attachments = [{
      type: 'inline_keyboard',
      payload: { buttons: keyboard },
    }];
  }

  return api('POST', `/messages?chat_id=${chatId}`, body);
}

function getUserName(update) {
  const user = update?.user || update?.message?.sender || {};
  return user.first_name || '';
}

function getChatId(update) {
  if (update?.update_type === 'bot_started') {
    return update?.chat_id;
  }
  if (update?.update_type === 'message_created') {
    return update?.message?.recipient?.chat_id;
  }
  return null;
}

function getStartKeyboard() {
  const botName = 'services_tomsk_bot';
  const appUrl = `https://max.ru/${botName}?startapp`;
  return [
    [{ type: 'link', text: 'Открыть', url: appUrl }],
  ];
}

async function handleStart(update) {
  const chatId = getChatId(update);
  if (!chatId) return;

  const name = getUserName(update);
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const msg = `${greeting}\n\nВас приветствует чат-бот «Сервисы региона» — витрина цифровых сервисов Томской области.\n\nНажмите «Открыть», чтобы начать пользоваться сервисом.`;

  await sendMessage(chatId, msg, getStartKeyboard());
}

async function processUpdate(update) {
  const eventType = update?.update_type;

  if (eventType === 'bot_started') {
    await handleStart(update);
    return;
  }

  if (eventType === 'message_created') {
    const text = update?.message?.body?.text || '';

    if (text === '/start') {
      await handleStart(update);
    }
  }
}

async function pollLoop() {
  let lastEventId = null;

  console.log('Проверка подключения к API...');
  try {
    const me = await api('GET', '/me');
    console.log('Бот:', me?.name || me);
  } catch (err) {
    console.error('Не удалось подключиться к API:', err.message);
  }

  console.log('Ожидание сообщений...');

  while (true) {
    try {
      const res = await getUpdates(lastEventId);

      const updates = res?.updates || [];

      for (const update of updates) {
        const eventId = update?.event_id || update?.timestamp;
        if (eventId) lastEventId = eventId;

        await processUpdate(update);
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

pollLoop();
