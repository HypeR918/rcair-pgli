import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWebhookBot } from '../transport/webhookBot.js';
import { startMaxTransport } from '../transport/maxTransport.js';
import { createMaxApi } from '../transport/maxApi.js';
import { MAX_UPDATE_TYPES, validateTransportConfig } from '../transport/config.js';
import { serializeUserUpdates } from '../utils/userUpdates.js';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import * as db from '../services/dbService.js';

const config = {
  BOT_TOKEN: 'offline-token', PORT: 3000, BOT_TRANSPORT: 'webhook',
  WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/', WEBHOOK_SECRET: 'offline-webhook-secret',
};
const logger = { log() {}, error() {} };
function payload(id = 'offline.mid', userId = 123) {
  return {
    update_type: 'message_created', timestamp: 1,
    message: {
      sender: { user_id: userId, first_name: 'Тест', is_bot: false },
      recipient: { chat_id: 456, chat_type: 'dialog' }, timestamp: 1,
      body: { mid: id, seq: 1, text: '/start', attachments: [] },
    },
  };
}

async function fixture(t, setup = () => {}, transportLogger = logger) {
  const calls = [];
  const bot = createWebhookBot(config.BOT_TOKEN);
  bot.use(serializeUserUpdates);
  setup(bot);
  const api = async (method, path, data) => {
    calls.push({ method, path, data });
    if (path === '/me') return { user_id: 999, username: 'offline_bot' };
    if (method === 'GET') return { subscriptions: [] };
    return { success: true };
  };
  const transport = await startMaxTransport(bot, config, { api, logger: transportLogger, host: '127.0.0.1', port: 0 });
  t.after(() => transport.stop());
  const base = `http://127.0.0.1:${transport.server.address().port}`;
  const deliver = (update = payload(), extra = {}) => fetch(`${base}/max/callback/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET },
    body: JSON.stringify(update), ...extra,
  });
  return { base, deliver, calls, bot, transport };
}

test('webhook требует HTTPS, допустимый секрет и не конфликтует с /health', () => {
  assert.equal(validateTransportConfig(config).path, '/max/callback/');
  assert.equal(validateTransportConfig({ ...config, BOT_TRANSPORT: undefined }).mode, 'webhook');
  assert.throws(() => validateTransportConfig({ PORT: 3000 }), /WEBHOOK_URL/);
  for (const change of [
    { BOT_TRANSPORT: 'unknown' }, { BOT_TRANSPORT: 'polling' }, { PORT: 0 }, { PORT: 65536 },
    { WEBHOOK_URL: '' }, { WEBHOOK_URL: 'http://botsupport.gov70.ru/max/callback/' },
    { WEBHOOK_URL: 'https://user:pass@botsupport.gov70.ru/max/callback/' },
    { WEBHOOK_URL: 'https://botsupport.gov70.ru/health' },
    { WEBHOOK_URL: `${config.WEBHOOK_URL}?secret=unsafe` },
    { WEBHOOK_URL: `${config.WEBHOOK_URL}#fragment` },
    { WEBHOOK_SECRET: '' }, { WEBHOOK_SECRET: 'short token with spaces' },
  ]) assert.throws(() => validateTransportConfig({ ...config, ...change }));
});

test('webhook регистрирует адрес, события и секрет; long polling MAX не запускается', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bot.start(), /только webhook/);
  await assert.rejects(f.bot.api.getUpdates(), /только webhook/);
  assert.deepEqual(f.calls, [
    { method: 'GET', path: '/subscriptions', data: undefined },
    { method: 'GET', path: '/me', data: undefined },
    { method: 'POST', path: '/subscriptions', data: {
      url: config.WEBHOOK_URL, update_types: MAX_UPDATE_TYPES, secret: config.WEBHOOK_SECRET,
    } },
  ]);
  const health = await fetch(`${f.base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'max-bot', transport: 'webhook' });
});

test('секрет проверяется до обработки; неверный метод и чужой маршрут отклоняются', async t => {
  let handled = 0;
  const f = await fixture(t, bot => bot.on('message_created', () => { handled++; }));
  for (const secret of ['', 'wrong-secret', `${config.WEBHOOK_SECRET}x`]) {
    const result = await f.deliver(payload(), { headers: {
      'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': secret,
    } });
    assert.equal(result.status, 403);
  }
  assert.equal(handled, 0);
  const get = await fetch(`${f.base}/max/callback/?check=external-test`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${f.base}/wrong`)).status, 404);
});

test('реальные SDK Context/command/action/on получают сообщение, callback и bot_started', async t => {
  const events = [];
  const f = await fixture(t, bot => {
    bot.api.sendMessageToChat = async (chatId, text) => { events.push({ chatId, text }); };
    bot.command('start', ctx => {
      assert.equal(ctx.myId, 999);
      assert.equal(ctx.user.user_id, 123);
      return ctx.reply('Тестовое меню');
    });
    bot.action('menu:tickets', ctx => { events.push(ctx.callback.payload); });
    bot.on('bot_started', ctx => { events.push(ctx.user.user_id); });
  });
  assert.equal((await f.deliver()).status, 200);
  assert.equal((await f.deliver({
    ...payload(), update_type: 'message_callback',
    callback: { callback_id: 'offline.callback', timestamp: 1, payload: 'menu:tickets', user: { user_id: 123 } },
  })).status, 200);
  assert.equal((await f.deliver({
    update_type: 'bot_started', timestamp: 2, chat_id: 456, user: { user_id: 123 },
  })).status, 200);
  assert.deepEqual(events, [{ chatId: 456, text: 'Тестовое меню' }, 'menu:tickets', 123]);
});

test('JSON, тип содержимого и лимит тела проверяются без вызова хендлеров', async t => {
  let handled = 0;
  const f = await fixture(t, bot => bot.on('message_created', () => { handled++; }));
  for (const body of ['{', '[]', 'null', '{}', '{"update_type":"message_created","timestamp":"bad"}']) {
    assert.equal((await f.deliver(null, { body })).status, 400);
  }
  assert.equal((await f.deliver(null, { headers: {
    'Content-Type': 'text/plain', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET,
  } })).status, 415);
  assert.equal((await f.deliver(null, { body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  // Проверяем и поток без Content-Length: ограничение действует на прочитанные байты.
  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${f.base}/max/callback/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write('x'.repeat(600000));
    request.end('x'.repeat(600000));
  });
  assert.equal(status, 413);
  assert.equal(handled, 0);
});

test('HTTP 200 приходит после обработки; параллельные и завершённые дубликаты не обрабатываются дважды', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let handled = 0;
  const f = await fixture(t, bot => bot.command('start', async () => {
    handled++; entered(); await gate;
  }));
  let acknowledged = false;
  const first = f.deliver().then(response => { acknowledged = true; return response; });
  await started;
  const second = f.deliver();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  assert.equal(handled, 1);
  release();
  for (const result of await Promise.all([first, second])) assert.equal(result.status, 200);
  assert.equal((await f.deliver()).status, 200);
  assert.equal(handled, 1);
  assert.equal((await f.deliver(payload('another.mid'))).status, 200);
  assert.equal(handled, 2);
});

test('диагностика различает обработку, повторы и ошибки без текста, MAX ID и секретов', async t => {
  const records = [];
  const errors = [];
  let fail = false;
  const f = await fixture(t, bot => bot.on('message_created', () => {
    if (fail) throw new Error('simulated handler failure');
  }), {
    log: (label, data) => { if (label === '[MAX_WEBHOOK]') records.push(JSON.parse(data)); },
    error: (...args) => errors.push(args),
  });
  const update = payload('sensitive-message-id', 987654321);
  update.message.body.text = '/start private-message-content';
  assert.equal((await f.deliver(update)).status, 200);
  assert.equal((await f.deliver(update)).status, 200);
  fail = true;
  update.message.body.mid = 'sensitive-failed-id';
  assert.equal((await f.deliver(update)).status, 500);
  assert.deepEqual(records.map(item => item.stage), [
    'received', 'finished', 'received', 'finished', 'received', 'failed',
  ]);
  assert.equal(records[0].type, 'message_created');
  assert.equal(records[0].start, true);
  assert.equal(records[0].has_user, true);
  assert.equal(records[1].result, 'processed');
  assert.equal(records[3].result, 'duplicate');
  assert.equal(records[5].status, 500);
  assert.equal(errors.length, 1);
  const output = JSON.stringify(records);
  for (const value of [
    '987654321', 'private-message-content', 'sensitive-message-id', 'sensitive-failed-id',
    config.WEBHOOK_SECRET, config.BOT_TOKEN,
  ]) assert(!output.includes(value));
});

test('ошибка хендлера даёт 500 и допускает повтор события без утечки текста ошибки', async t => {
  let attempts = 0;
  const f = await fixture(t, bot => bot.command('start', () => {
    if (++attempts === 1) throw Object.assign(new Error('private diagnostic'), { status: 403 });
  }));
  const failed = await f.deliver();
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false });
  assert.equal((await f.deliver()).status, 200);
  assert.equal(attempts, 2);
});

for (const kind of ['message_created', 'bot_started']) {
  test(`${kind}: настоящий обработчик старта не подтверждает событие, если MAX не принимает ни один ответ`, async t => {
    const controller = await loadIsolated('controllers/userController.js', {
      './config/env.js': { env: {} },
      './services/dbService.js': Object.fromEntries(Object.keys(db).map(name => [name, noop])),
      './state/sessionStore.js': { getSession: () => null, setSession: noop, deleteSession: noop },
    });
    let reject = true;
    let replies = 0;
    const f = await fixture(t, bot => {
      bot.api.sendMessageToChat = async () => {
        if (reject) throw Object.assign(new Error('simulated MAX reply rejection'), { status: 403 });
        replies++;
      };
      controller.registerUserHandlers(bot);
    });
    const update = kind === 'message_created' ? payload() : {
      update_type: 'bot_started', timestamp: 1, chat_id: 456, user: { user_id: 123 },
    };
    assert.equal((await f.deliver(update)).status, 500);
    assert.equal(replies, 0);
    reject = false;
    assert.equal((await f.deliver(update)).status, 200);
    assert.equal(replies, 1);
  });
}

test('чужие подписки сохраняются без удаления', async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push({ method, path });
    return { subscriptions: [{ url: 'https://another.example/callback/' }] };
  };
  await assert.rejects(startMaxTransport(createWebhookBot('offline'), config, { api, logger }), /другой webhook/);
  assert.deepEqual(calls, [{ method: 'GET', path: '/subscriptions' }]);
});

test('BOT_TRANSPORT=polling отклоняется до любых сетевых запросов', async () => {
  let calls = 0;
  const api = async () => { calls++; };
  await assert.rejects(startMaxTransport(createWebhookBot('offline'), { ...config, BOT_TRANSPORT: 'polling' }, { api, logger }), /только BOT_TRANSPORT=webhook/);
  assert.equal(calls, 0);
});

test('своя подписка повторно регистрируется без удаления', async t => {
  const calls = [];
  const api = async (method, path) => {
    calls.push(method);
    if (path === '/me') return { user_id: 999 };
    return method === 'GET' ? { subscriptions: [{ url: config.WEBHOOK_URL }] } : { success: true };
  };
  const transport = await startMaxTransport(createWebhookBot('offline'), config, { api, logger, port: 0, host: '127.0.0.1' });
  t.after(() => transport.stop());
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
});

test('неподтверждённая подписка закрывает listener; до регистрации readiness=503', async () => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const api = async (method, path) => {
    if (path === '/me') return { user_id: 999 };
    if (method === 'GET') return { subscriptions: [] };
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
    return { success: false };
  };
  await assert.rejects(startMaxTransport(createWebhookBot('offline'), config, { api, logger, port, host: '127.0.0.1' }), /не подтвердил/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test('webhook по умолчанию останавливает HTTP-сервер без lifecycle polling SDK', async () => {
  const bot = createWebhookBot('offline');
  bot.stop = () => { throw new Error('SDK polling lifecycle не должен вызываться'); };
  const api = async (_method, path) => path === '/me' ? { user_id: 999 } : { subscriptions: [], success: true };
  const transport = await startMaxTransport(bot, { ...config, BOT_TRANSPORT: undefined }, { api, logger, port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${transport.server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/max/callback/`)).status, 405);
    assert.equal((await (await fetch(`${url}/health`)).json()).transport, 'webhook');
  } finally { await transport.stop(); }
  await assert.rejects(fetch(`${url}/health`));
});

test('MAX API передаёт секрет в JSON, не следует redirect и скрывает Authorization в ошибках', async t => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, token: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end('{}'); }
    else if (req.url === '/fail') { res.writeHead(401); res.end('{}'); }
    else res.end('{"success":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = createMaxApi('private-offline-token', `http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(await api('POST', '/subscriptions', { secret: config.WEBHOOK_SECRET }), { success: true });
  assert.equal(received[0].token, 'private-offline-token');
  assert.equal(JSON.parse(received[0].body).secret, config.WEBHOOK_SECRET);
  await assert.rejects(api('GET', '/redirect'), /HTTP 302/);
  await assert.rejects(api('GET', '/fail'), error => {
    assert.equal(error.message, 'MAX API GET /fail: HTTP 401');
    assert.equal(error.config, undefined);
    assert(!String(error.stack).includes('private-offline-token'));
    return true;
  });
  assert(!received.some(item => item.path === '/must-not-follow'));
});
