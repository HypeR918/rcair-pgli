import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebhookBot } from '../transport/webhookBot.js';
import { startMaxTransport } from '../transport/maxTransport.js';
import { diagnoseWebhook } from '../scripts/diagnose-webhook.mjs';

async function fixture(t, removeSecret = false, wrongUpstream = false) {
  const dir = await mkdtemp(join(tmpdir(), 'rcair-diagnostic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=botsupport.gov70.ru', '-addext', 'subjectAltName=DNS:botsupport.gov70.ru',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'));
  const key = await readFile(join(dir, 'key.pem'));
  const config = {
    BOT_TOKEN: 'private-offline-token', BOT_TRANSPORT: 'webhook', PORT: 3000,
    WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/', WEBHOOK_SECRET: 'private-offline-secret',
  };
  const bot = createWebhookBot(config.BOT_TOKEN);
  let handlers = 0;
  bot.on('message_created', () => { handlers++; });
  const transport = await startMaxTransport(bot, config, {
    api: async (_method, path) => path === '/me' ? { user_id: 999 } : { subscriptions: [], success: true },
    logger: { log() {}, error() {} }, host: '127.0.0.1', port: 0,
  });
  t.after(() => transport.stop());
  config.PORT = transport.server.address().port;
  const tlsProxy = https.createServer({ key, cert }, (req, res) => {
    if (wrongUpstream) {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const headers = { ...req.headers };
    if (removeSecret) delete headers['x-max-bot-api-secret'];
    const upstream = http.request({ host: '127.0.0.1', port: config.PORT, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('{}'); });
    req.pipe(upstream);
  });
  tlsProxy.listen(0, '127.0.0.1'); await once(tlsProxy, 'listening');
  t.after(async () => {
    tlsProxy.closeAllConnections();
    await new Promise(resolve => tlsProxy.close(resolve));
  });
  const output = [];
  const apiCalls = [];
  const options = {
    config, nginxHost: '127.0.0.1', nginxPort: tlsProxy.address().port, ca: cert, watchSeconds: 0,
    log: text => output.push(text),
    api: async (method, path) => {
      apiCalls.push({ method, path });
      if (path === '/me') return { user_id: 999, username: 'offline_bot', private: config.BOT_TOKEN };
      return { subscriptions: [{ url: config.WEBHOOK_URL, update_types: ['message_created', 'message_callback', 'bot_started'], secret: config.WEBHOOK_SECRET }] };
    },
  };
  return { options, output, apiCalls, getHandlers: () => handlers };
}

test('диагностика проверяет подписку, настоящий POST и TLS, не вызывает бизнес-обработчики и не печатает секреты', async t => {
  const f = await fixture(t);
  const result = await diagnoseWebhook(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.node_status, 200);
  assert.equal(result.nginx_status, 200);
  assert.equal(result.snapshot.ignored, 2);
  assert.equal(result.snapshot.types.message_created, 0);
  assert.deepEqual(result.snapshot.replies, { attempted: 0, confirmed: 0, failed: 0 });
  assert.deepEqual(result.snapshot.recent_events, []);
  assert.equal(f.getHandlers(), 0);
  assert.deepEqual(f.apiCalls, [{ method: 'GET', path: '/me' }, { method: 'GET', path: '/subscriptions' }]);
  const output = f.output.join('\n');
  assert.match(output, /offline_bot/);
  assert(!output.includes(f.options.config.BOT_TOKEN));
  assert(!output.includes(f.options.config.WEBHOOK_SECRET));
});

test('диагностика различает прямой POST200 и потерю заголовка секрета на TLS-прокси', async t => {
  const f = await fixture(t, true);
  const result = await diagnoseWebhook(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.node_status, 200);
  assert.equal(result.nginx_status, 403);
  assert.equal(result.snapshot.rejected, 1);
});

test('диагностика проверяет имя сертификата, даже когда подключается к внутреннему IP', async t => {
  const f = await fixture(t);
  f.options.config.WEBHOOK_URL = 'https://wrong-name.example/max/callback/';
  const result = await diagnoseWebhook(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.node_status, 200);
  assert.equal(result.nginx_status, null);
  assert(f.output.some(line => line.includes('ERR_TLS_CERT_ALTNAME_INVALID')));
});

test('локальный режим диагностики не обращается к MAX API', async t => {
  const f = await fixture(t);
  const result = await diagnoseWebhook({ ...f.options, localOnly: true });
  assert.equal(result.ok, true);
  assert.equal(f.apiCalls.length, 0);
});

test('HTTP200 от другого upstream не считается доставкой пробы текущему процессу бота', async t => {
  const f = await fixture(t, false, true);
  const result = await diagnoseWebhook({ ...f.options, localOnly: true });
  assert.equal(result.node_status, 200);
  assert.equal(result.nginx_status, 200);
  assert.equal(result.snapshot.received, 1);
  assert.equal(result.snapshot.ignored, 1);
  assert.equal(result.ok, false, 'Чужой HTTP200 ошибочно принят за проверку текущего webhook');
});
