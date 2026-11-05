import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebhookBot } from '../transport/webhookBot.js';
import { createMaxApi } from '../transport/maxApi.js';
import { startMaxTransport } from '../transport/maxTransport.js';
import { serializeUserUpdates } from '../utils/userUpdates.js';
import { State } from '../utils/constants.js';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import * as db from '../services/dbService.js';
import * as glpi from '../services/glpiService.js';

const config = {
  BOT_TOKEN: 'offline-token', PORT: 3000, BOT_TRANSPORT: 'webhook',
  WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/', WEBHOOK_SECRET: 'offline-secret',
};

function message(mid, text = '/start', userId = 123) {
  return {
    update_type: 'message_created', timestamp: 1,
    message: {
      sender: { user_id: userId, first_name: 'Тест', is_bot: false },
      recipient: { chat_id: userId * 10, chat_type: 'dialog' }, timestamp: 1,
      body: { mid, text, attachments: [] },
    },
  };
}

async function fixture(t, setup = bot => bot.command('start', ctx => ctx.reply('Тестовое меню')), timeout = 80) {
  const replies = [];
  const records = [];
  let mode = 'normal';
  let firstReceived;
  let firstClosed;
  const received = new Promise(resolve => { firstReceived = resolve; });
  const closed = new Promise(resolve => { firstClosed = resolve; });
  const apiServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, 'http://fixture').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path === '/me') return res.end('{"user_id":999,"username":"offline_bot"}');
    if (path === '/subscriptions') return res.end(req.method === 'GET'
      ? '{"subscriptions":[]}' : '{"success":true}');
    if (path !== '/messages') { res.writeHead(404); return res.end('{"message":"unexpected"}'); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    replies.push({ body, query: new URL(req.url, 'http://fixture').searchParams });
    if (mode === 'reject') { res.writeHead(503); return res.end('{"message":"offline failure"}'); }
    if (mode === 'unconfirmed') return res.end('{"success":false,"message":"private response"}');
    if (replies.length === 1 && mode.startsWith('hang')) {
      res.on('close', firstClosed);
      if (mode === 'hang-body') { res.writeHead(200); res.write('{"message":'); }
      firstReceived();
      return;
    }
    res.end(JSON.stringify({ message: { body: { mid: 'reply.mid', text: body.text } } }));
  });
  apiServer.listen(0, '127.0.0.1'); await once(apiServer, 'listening');
  let transport;
  t.after(async () => {
    apiServer.closeAllConnections();
    await new Promise(resolve => apiServer.close(resolve));
    await transport?.stop();
  });
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
  const bot = createWebhookBot(config.BOT_TOKEN, { clientOptions: { baseUrl: apiUrl, timeout } });
  bot.use(serializeUserUpdates);
  await setup(bot);
  transport = await startMaxTransport(bot, config, {
    api: createMaxApi(config.BOT_TOKEN, apiUrl), logger: {
      log(label, data) { if (label === '[MAX_WEBHOOK]') records.push(JSON.parse(data)); }, error() {},
    },
    host: '127.0.0.1', port: 0,
  });
  const base = `http://127.0.0.1:${transport.server.address().port}`;
  const deliver = async update => {
    const response = await fetch(`${base}/max/callback/`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET,
      }, body: JSON.stringify(update),
    });
    await response.text();
    return response.status;
  };
  return { bot, base, deliver, replies, records, received, closed, setMode: value => { mode = value; } };
}

async function deadline(promise, label) {
  const result = await Promise.race([promise, delay(600).then(() => 'still-pending')]);
  assert.notEqual(result, 'still-pending', label);
  return result;
}

test('HTTP 200 без сообщения MAX не подтверждает ответ и не подавляет повтор события', async t => {
  const f = await fixture(t);
  const update = message('unconfirmed.reply');
  f.setMode('unconfirmed');
  assert.equal(await f.deliver(update), 500, 'Пустое подтверждение MAX ошибочно считается доставленным ответом');
  f.setMode('normal');
  assert.equal(await f.deliver(update), 200);
  assert.equal(await f.deliver(update), 200);
  assert.equal(f.replies.length, 2, 'Ошибка не должна попасть в дедупликацию, успех — должен');
  assert(!JSON.stringify(f.records).includes('private response'));
});

test('диагностика связывает событие с подтверждением MAX, а обработку без ответа показывает отдельно', async t => {
  const f = await fixture(t, bot => bot.on('message_created', async ctx => {
    if (ctx.message.body.text === '/start') await ctx.reply('Тестовое меню');
  }));
  assert.equal(await f.deliver(message('reply.confirmed')), 200);
  assert.equal(await f.deliver(message('reply.none', 'Текст без ответа')), 200);
  f.setMode('unconfirmed');
  assert.equal(await f.deliver(message('reply.failed')), 500);
  const snapshot = await (await fetch(`${f.base}/diagnostics`)).json();
  assert.deepEqual(snapshot.replies, { attempted: 2, confirmed: 1, failed: 1 });
  assert.deepEqual(snapshot.recent_events.map(event => [event.type, event.status, event.replies]), [
    ['message_created', 200, { attempted: 1, confirmed: 1, failed: 0 }],
    ['message_created', 200, { attempted: 0, confirmed: 0, failed: 0 }],
    ['message_created', 500, { attempted: 1, confirmed: 0, failed: 1 }],
  ]);
  const completed = f.records.filter(record => ['finished', 'failed'].includes(record.stage));
  assert.deepEqual(completed.map(record => record.replies), snapshot.recent_events.map(event => event.replies));
  const output = JSON.stringify(snapshot) + JSON.stringify(f.records);
  for (const secret of ['private response', 'Тестовое меню', 'Текст без ответа', config.BOT_TOKEN, config.WEBHOOK_SECRET]) {
    assert(!output.includes(secret));
  }
});

for (const mode of ['hang-headers', 'hang-body']) {
  test(`${mode}: SDK отменяет HTTP, освобождает диалог; другой пользователь не блокируется`, async t => {
    const f = await fixture(t);
    f.setMode(mode);
    const first = f.deliver(message(`${mode}.first`));
    await f.received;
    const second = f.deliver(message(`${mode}.second`));
    assert.equal(await f.deliver(message(`${mode}.other`, '/start', 456)), 200);
    assert.equal((await fetch(`${f.base}/health`)).status, 200);
    assert.equal(await deadline(first, 'Первый webhook не завершился после таймаута SDK'), 500);
    await deadline(f.closed, 'Исходящий HTTP-сокет не закрыт');
    assert.equal(await deadline(second, 'Следующее сообщение пользователя заблокировано'), 200);
    assert.equal(f.replies.length, 3);
    const snapshot = await (await fetch(`${f.base}/diagnostics`)).json();
    assert.deepEqual(snapshot.replies, { attempted: 3, confirmed: 2, failed: 1 });
    assert.deepEqual(snapshot.recent_events.sort((a, b) => a.event - b.event).map(event => event.replies), [
      { attempted: 1, confirmed: 0, failed: 1 },
      { attempted: 1, confirmed: 1, failed: 0 },
      { attempted: 1, confirmed: 1, failed: 0 },
    ], 'Параллельные диалоги не должны смешивать подтверждения ответов');
  });
}

test('история хранит последние 20 реальных событий, диагностические пробы её не вытесняют', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) assert.equal(await f.deliver(message(`history.${i}`, 'Без ответа')), 200);
  assert.equal(await f.deliver({ update_type: 'diagnostic_probe', timestamp: 1 }), 200);
  const snapshot = await (await fetch(`${f.base}/diagnostics`)).json();
  assert.equal(snapshot.received, 26);
  assert.equal(snapshot.recent_events.length, 20);
  assert.equal(snapshot.recent_events[0].event, 6);
  assert.equal(snapshot.recent_events.at(-1).event, 25);
  assert(snapshot.recent_events.every(event => event.type === 'message_created'));
});

test('диагностика различает зависший MAX API и очередь следующего сообщения', async t => {
  const f = await fixture(t, undefined, 500);
  f.setMode('hang-headers');
  const first = f.deliver(message('phase.first'));
  await f.received;
  const second = f.deliver(message('phase.second'));
  let busy;
  for (let attempt = 0; attempt < 20; attempt++) {
    busy = await (await fetch(`${f.base}/diagnostics`)).json();
    if (busy.active === 2) break;
    await delay(2);
  }
  assert.equal(busy.active, 2);
  assert.equal(busy.active_phases?.['max.api'], 1);
  assert.equal(busy.active_phases?.['dialog.wait'], 1);
  assert.equal(busy.oldest_phase, 'max.api');
  assert.equal(await deadline(first, 'Первое событие не завершено'), 500);
  assert.equal(f.records.find(record => record.stage === 'failed')?.phase, 'max.api');
  assert.equal(await deadline(second, 'Очередь не освобождена'), 200);
  assert.equal((await (await fetch(`${f.base}/diagnostics`)).json()).active, 0);
});

function controllerMocks(sessions) {
  return {
    './config/env.js': { env: {} },
    './services/dbService.js': {
      ...Object.fromEntries(Object.keys(db).map(name => [name, noop])),
      isMaxIdBlocked: async () => false, findGlpiUserByMaxId: async () => null,
    },
    './services/glpiService.js': Object.fromEntries(Object.keys(glpi).map(name => [name, noop])),
    './state/sessionStore.js': {
      getSession: id => structuredClone(sessions.get(String(id)) || null),
      setSession: async (id, value) => sessions.set(String(id), structuredClone(value)),
      deleteSession: async id => sessions.delete(String(id)),
    },
  };
}

for (const state of [State.WAIT_NEW_TICKET_TITLE, State.WAIT_NEW_TICKET_DESCRIPTION]) {
  test(`${state}: отказ отправки и повтор mid сохраняют единственный переход диалога`, async t => {
    const sessions = new Map([['123', {
      state, glpiUserId: 42, ticketDraft: { title: 'Сеть: проблема', description: '', files: [] },
    }]]);
    const controller = await loadIsolated('controllers/messageController.js', controllerMocks(sessions));
    const f = await fixture(t, bot => controller.registerMessageHandler(bot));
    f.setMode('reject');
    const update = message(`retry.${state}`, 'Не работает принтер');
    assert.equal(await f.deliver(update), 500);
    assert.equal(sessions.get('123').state, state, 'Недоставленный вопрос не должен менять ожидаемый ввод');
    f.setMode('normal');
    assert.equal(await f.deliver(update), 200);
    const session = sessions.get('123');
    assert.equal(session.state, state === State.WAIT_NEW_TICKET_TITLE
      ? State.WAIT_NEW_TICKET_DESCRIPTION : State.WAIT_NEW_TICKET_FILES);
    assert.equal(session.ticketDraft.description, state === State.WAIT_NEW_TICKET_TITLE ? '' : 'Не работает принтер');
    assert.equal(await f.deliver(update), 200);
    assert.deepEqual(sessions.get('123'), session);
  });
}

test('повтор bot_started не сбрасывает продолженный диалог; новое событие старта обрабатывается', async t => {
  const sessions = new Map();
  const controller = await loadIsolated('controllers/userController.js', controllerMocks(sessions));
  const f = await fixture(t, bot => controller.registerUserHandlers(bot));
  const update = { update_type: 'bot_started', timestamp: 10, chat_id: 1230, user: { user_id: 123 } };
  assert.equal(await f.deliver(update), 200);
  sessions.set('123', { state: State.WAIT_SDS_ORG, verifiedEmail: 'offline@example.test' });
  assert.equal(await f.deliver(update), 200);
  assert.equal(sessions.get('123').state, State.WAIT_SDS_ORG);
  assert.equal(f.replies.length, 1);
  assert.equal(await f.deliver({ ...update, timestamp: 11 }), 200);
  assert.equal(sessions.get('123').state, State.WAIT_NEW_USER_EMAIL);
  assert.equal(f.replies.length, 2);
});

for (const original of [null, undefined]) {
  test(`callback без исходного message (${String(original)}): личный ответ через user_id`, async t => {
    const sessions = new Map();
    const controller = await loadIsolated('controllers/ticketController.js', controllerMocks(sessions));
    const f = await fixture(t, bot => controller.registerTicketActions(bot));
    const update = {
      update_type: 'message_callback', timestamp: 1,
      callback: { callback_id: 'offline.callback', timestamp: 1, payload: 'menu:start_auth', user: { user_id: 123 } },
    };
    if (original === null) update.message = null;
    assert.equal(await f.deliver(update), 200);
    assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0].query.get('user_id'), '123');
    assert.equal(f.replies[0].query.has('chat_id'), false);
    assert.equal(f.replies[0].body.text, 'Введите Ваш корпоративный email');
    assert.equal(await f.deliver(update), 200);
    assert.equal(f.replies.length, 1);
  });
}
