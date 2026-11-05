import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWebhookBot } from '../transport/webhookBot.js';
import { createMaxApi } from '../transport/maxApi.js';
import { startMaxTransport } from '../transport/maxTransport.js';
import { serializeUserUpdates } from '../utils/userUpdates.js';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import * as db from '../services/dbService.js';
import * as glpi from '../services/glpiService.js';

test('реальный SDK: команды, текст, кнопки, bot_started и уведомления без единого запроса /updates', async t => {
  const requests = [];
  const maxApi = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: req.method, path, body, query: new URL(req.url, 'http://fixture').searchParams });
    res.setHeader('Content-Type', 'application/json');
    if (path === '/me') res.end('{"user_id":999,"username":"offline_bot"}');
    else if (path === '/subscriptions') res.end(req.method === 'GET' ? '{"subscriptions":[]}' : '{"success":true}');
    else if (path === '/messages') res.end(JSON.stringify({ message: { body: { mid: 'offline.reply', text: body.text } } }));
    else { res.statusCode = 500; res.end('{"error":"unexpected API request"}'); }
  });
  maxApi.listen(0, '127.0.0.1'); await once(maxApi, 'listening');
  t.after(() => new Promise(resolve => maxApi.close(resolve)));
  const apiUrl = `http://127.0.0.1:${maxApi.address().port}`;
  const config = {
    PORT: 3000, BOT_TOKEN: 'offline-only-token', WEBHOOK_SECRET: 'offline-only-secret',
    WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/',
  };
  const bot = createWebhookBot(config.BOT_TOKEN, { clientOptions: { baseUrl: apiUrl } });
  bot.use(serializeUserUpdates);

  const sessions = new Map();
  const mocks = {
    './config/env.js': { env: {} },
    './services/dbService.js': {
      ...Object.fromEntries(Object.keys(db).map(name => [name, noop])),
      isMaxIdBlocked: async () => false,
      findGlpiUserByMaxId: async () => ({ id: 42, firstname: 'Тест' }),
    },
    './services/glpiService.js': Object.fromEntries(Object.keys(glpi).map(name => [name, noop])),
    './state/sessionStore.js': {
      getSession: id => structuredClone(sessions.get(id)),
      setSession: async (id, value) => sessions.set(id, structuredClone(value)),
      deleteSession: async id => sessions.delete(id),
    },
  };
  const users = await loadIsolated('controllers/userController.js', mocks);
  const messages = await loadIsolated('controllers/messageController.js', mocks);
  const tickets = await loadIsolated('controllers/ticketController.js', mocks);
  users.registerUserHandlers(bot);
  messages.registerMessageHandler(bot);
  tickets.registerTicketActions(bot);

  const transport = await startMaxTransport(bot, config, {
    api: createMaxApi(config.BOT_TOKEN, apiUrl),
    logger: { log() {}, error() {} }, host: '127.0.0.1', port: 0,
  });
  t.after(() => transport.stop());
  const webhookUrl = `http://127.0.0.1:${transport.server.address().port}/max/callback/`;
  const baseMessage = {
    sender: { user_id: 123, first_name: 'Тест', is_bot: false },
    recipient: { chat_id: 456, chat_type: 'dialog' }, timestamp: 1,
    body: { mid: 'start.mid', text: '/start', attachments: [] },
  };
  const events = [
    { update_type: 'message_created', timestamp: 1, message: baseMessage },
    { update_type: 'message_created', timestamp: 2, message: {
      ...baseMessage, body: { mid: 'text.mid', text: 'Тестовое сообщение', attachments: [] },
    } },
    { update_type: 'message_callback', timestamp: 3, message: baseMessage,
      callback: { callback_id: 'menu.callback', timestamp: 3, payload: 'menu:back', user: { user_id: 123 } } },
    { update_type: 'bot_started', timestamp: 4, chat_id: 456, user: { user_id: 123 } },
  ];
  const deliver = update => fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
  for (const event of events) {
    const response = await deliver(event);
    assert.equal(response.status, 200);
    await response.json();
  }
  await bot.api.sendMessageToUser(123, 'Тестовое уведомление GLPI');
  assert.equal((await deliver(events[0])).status, 200);

  const replies = requests.filter(request => request.path === '/messages');
  assert.equal(replies.length, 5);
  assert.match(replies[0].body.text, /Добро пожаловать/);
  assert.match(replies[1].body.text, /Используйте меню/);
  assert.equal(replies[2].body.text, 'Главное меню:');
  assert.match(replies[3].body.text, /Добро пожаловать/);
  assert.equal(replies[4].body.text, 'Тестовое уведомление GLPI');
  assert.equal(replies[0].query.get('chat_id'), '456');
  assert.equal(replies[4].query.get('user_id'), '123');
  assert(requests.some(request => request.path === '/subscriptions' && request.method === 'POST'));

  const before = requests.length;
  for (const attempt of [
    () => bot.start(),
    () => bot.api.getUpdates(),
    () => bot.api.raw.subscriptions.getUpdates({}),
    () => bot.api.raw.get('updates'),
    () => bot.api.raw.get('/updates?marker=123'),
    () => bot.api.raw.get('/updates/'),
    () => createMaxApi(config.BOT_TOKEN, apiUrl)('GET', '/updates'),
    () => createMaxApi(config.BOT_TOKEN, apiUrl)('POST', '/updates'),
  ]) await assert.rejects(attempt(), /только webhook/);
  assert.throws(() => { bot.start = noop; }, TypeError);
  assert.throws(() => { bot.api.getUpdates = noop; }, TypeError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, before);
  assert.equal(requests.filter(request => request.path.startsWith('/updates')).length, 0);
  assert.equal((await bot.api.getMyInfo()).username, 'offline_bot');
  assert.equal((await bot.api.raw.get('me')).username, 'offline_bot');
});
