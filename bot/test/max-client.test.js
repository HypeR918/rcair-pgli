import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebhookBot } from '../transport/webhookBot.js';

async function fixture(t, respond = (_req, res) => res.end('{"success":true}')) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method, url: new URL(req.url, 'http://fixture'),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      token: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');
    respond(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const bot = createWebhookBot('private-offline-token', { clientOptions: { baseUrl, timeout: 100 } });
  return { bot, requests, baseUrl };
}

test('низкоуровневые SDK-вызовы /updates блокируются до HTTP, включая кодированный путь', async t => {
  const f = await fixture(t);
  for (const attempt of [
    () => f.bot.api.raw.post('/updates'),
    () => f.bot.api.raw.call({ method: 'updates', options: {} }),
    () => f.bot.api.raw.get('/%75pdates'),
    () => f.bot.api.raw.get('/updates%2F'),
  ]) await assert.rejects(attempt(), /\/updates запрещён/);
  assert.equal(f.requests.length, 0);
});

test('публичный SDK сохраняет маршруты, параметры callback, тело, false и авторизацию', async t => {
  const f = await fixture(t, (_req, res) => res.end('{"message":{"body":{"mid":"reply.mid"}}}'));
  await f.bot.api.getChat(42);
  await f.bot.api.sendMessageToUser(123, 'Текст', { disable_link_preview: false });
  await f.bot.api.answerOnCallback('callback.id', { notification: 'Готово' });
  await f.bot.api.getMessage('message id');
  assert.deepEqual(f.requests.map(r => [r.method, r.url.pathname]), [
    ['GET', '/chats/42'], ['POST', '/messages'], ['POST', '/answers'], ['GET', '/messages/message%20id'],
  ]);
  assert.equal(f.requests[1].url.searchParams.get('user_id'), '123');
  assert.equal(f.requests[1].url.searchParams.get('disable_link_preview'), 'false');
  assert.equal(f.requests[1].body.text, 'Текст');
  assert.equal(f.requests[2].url.searchParams.get('callback_id'), 'callback.id');
  assert.equal(f.requests[2].body.notification, 'Готово');
  assert(f.requests.every(r => r.token === 'private-offline-token'));
});

test('SDK не следует redirect, не отправляет токен другому серверу и отвергает битый JSON', async t => {
  let mode = 'redirect';
  const f = await fixture(t, (_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end('{}'); }
    else res.end('invalid JSON with private response');
  });
  await assert.rejects(f.bot.api.getMyInfo(), error => error.status === 302);
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.bot.api.raw.get('https://other.example/me'), /другому серверу/);
  assert.equal(f.requests.length, 1);
  mode = 'invalid';
  await assert.rejects(f.bot.api.getMyInfo(), error => {
    assert(!String(error.stack).includes('private-offline-token'));
    assert(!String(error.stack).includes('private response'));
    assert.equal(error.config, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('attachment.not.ready имеет конечное число повторов вместо вечной блокировки SDK', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400);
    res.end('{"code":"attachment.not.ready","message":"not ready"}');
  });
  const sending = f.bot.api.sendMessageToUser(123, 'Вложение').then(() => null, error => error);
  const result = await Promise.race([sending, delay(2600).then(() => 'still-pending')]);
  assert.notEqual(result, 'still-pending', 'SDK бесконечно повторяет отправку');
  assert.equal(result.code, 'attachment.not.ready');
  assert.equal(f.requests.length, 3);
});
