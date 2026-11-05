import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Bot } from '@maxhub/max-bot-api';
import { startMaxTransport } from '../transport/maxTransport.js';
import { createMaxApi } from '../transport/maxApi.js';
import { MAX_UPDATE_TYPES, validateTransportConfig } from '../transport/config.js';
import { serializeUserUpdates } from '../utils/userUpdates.js';

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

async function fixture(t, setup = () => {}) {
  const calls = [];
  const bot = new Bot(config.BOT_TOKEN);
  bot.use(serializeUserUpdates);
  let polling = 0;
  bot.start = async () => { polling++; };
  setup(bot);
  const api = async (method, path, data) => {
    calls.push({ method, path, data });
    if (path === '/me') return { user_id: 999, username: 'offline_bot' };
    if (method === 'GET') return { subscriptions: [] };
    return { success: true };
  };
  const transport = await startMaxTransport(bot, config, { api, logger, host: '127.0.0.1', port: 0 });
  t.after(() => transport.stop());
  const base = `http://127.0.0.1:${transport.server.address().port}`;
  const deliver = (update = payload(), extra = {}) => fetch(`${base}/max/callback/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': config.WEBHOOK_SECRET },
    body: JSON.stringify(update), ...extra,
  });
  return { base, deliver, calls, bot, transport, get polling() { return polling; } };
}

test('webhook требует HTTPS, допустимый секрет и не конфликтует с /health', () => {
  assert.equal(validateTransportConfig(config).path, '/max/callback/');
  assert.equal(validateTransportConfig({ PORT: 3000 }).mode, 'polling');
  for (const change of [
    { BOT_TRANSPORT: 'unknown' }, { PORT: 0 }, { PORT: 65536 },
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
  assert.equal(f.polling, 0);
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

test('чужие подписки сохраняются; polling с активным webhook запрещён', async () => {
  for (const mode of ['webhook', 'polling']) {
    const calls = [];
    const api = async (method, path) => {
      calls.push({ method, path });
      return { subscriptions: [{ url: 'https://another.example/callback/' }] };
    };
    await assert.rejects(startMaxTransport(new Bot('offline'), { ...config, BOT_TRANSPORT: mode }, { api, logger }), /другой webhook/);
    assert.deepEqual(calls, [{ method: 'GET', path: '/subscriptions' }]);
  }
});

test('своя подписка повторно регистрируется без удаления', async t => {
  const calls = [];
  const api = async (method, path) => {
    calls.push(method);
    if (path === '/me') return { user_id: 999 };
    return method === 'GET' ? { subscriptions: [{ url: config.WEBHOOK_URL }] } : { success: true };
  };
  const transport = await startMaxTransport(new Bot('offline'), config, { api, logger, port: 0, host: '127.0.0.1' });
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
  await assert.rejects(startMaxTransport(new Bot('offline'), config, { api, logger, port, host: '127.0.0.1' }), /не подтвердил/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test('polling сохраняет старый режим и останавливается вместе с HTTP-сервером', async () => {
  const bot = new Bot('offline');
  let started = 0;
  let stopped = 0;
  let finish;
  bot.start = async options => {
    assert.deepEqual(options.allowedUpdates, MAX_UPDATE_TYPES);
    started++;
    await new Promise(resolve => { finish = resolve; });
  };
  bot.stop = () => { stopped++; finish(); };
  const api = async (_method, path) => path === '/me' ? { user_id: 999 } : { subscriptions: [] };
  const transport = await startMaxTransport(bot, { ...config, BOT_TRANSPORT: 'polling' }, { api, logger, port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${transport.server.address().port}`;
  try {
    assert.equal(started, 1);
    assert.equal((await fetch(`${url}/max/callback/`)).status, 404);
    assert.equal((await (await fetch(`${url}/health`)).json()).transport, 'polling');
  } finally { await transport.stop(); }
  assert.equal(stopped, 1);
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
