import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBroadcastApi } from '../broadcast/api.js';

const secret = 'b'.repeat(64);
async function fixture(t, store = {}, key = secret) {
  const api = createBroadcastApi(store, key);
  const server = http.createServer(async (req, res) => {
    if (!await api(req, res)) { req.resume(); res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/internal/broadcasts`;
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'notice-test-01' };
  return { url, headers };
}

test('API рассылок требует отдельный секрет и без него выключен', async t => {
  const { url } = await fixture(t, { create: () => { throw new Error('Не должен вызываться'); } });
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  const disabled = await fixture(t, {}, '');
  assert.equal((await fetch(disabled.url)).status, 404);
  assert.throws(() => createBroadcastApi({}, 'short'), /BROADCAST_API_SECRET/);
});

test('API принимает только текст с idempotency key; в ответе нет текста и адресатов', async t => {
  const calls = [];
  const { url, headers } = await fixture(t, { create: async (...args) => { calls.push(args); return { id: '7', created: true }; } });
  const text = 'Плановые работы. Пароли и коды в ответ отправлять не нужно.';
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: '7', created: true, status_url: '/internal/broadcasts/7' });
  assert.deepEqual(calls, [['notice-test-01', text]]);
  for (const body of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 'hello', user_id: 1 }, { text: 'hello', max_id: '12' }, []]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Idempotency-Key': '' }, body: '{"text":"x"}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(33000) })).status, 413);
  assert.equal(calls.length, 1);
});

test('API возвращает статус и безопасные ошибки, конфликт ключа — 409', async t => {
  const { url, headers } = await fixture(t, {
    create: async () => { const error = new Error('secret text'); error.code = 'BROADCAST_KEY_CONFLICT'; throw error; },
    status: async id => id === '7' ? { id, counts: { done: 2 } } : null,
  });
  const response = await fetch(url, { method: 'POST', headers, body: '{"text":"x"}' });
  assert.equal(response.status, 409);
  assert(!await response.text().then(text => text.includes('secret text')));
  assert.deepEqual(await (await fetch(`${url}/7`, { headers })).json(), { id: '7', counts: { done: 2 } });
  assert.equal((await fetch(`${url}/8`, { headers })).status, 404);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(`${url}/0`, { headers })).status, 404);
});

test('test endpoint всегда выбирает ровно одного явно заданного получателя', async t => {
  const calls = [];
  const { url, headers } = await fixture(t, { create: async (...args) => {
    calls.push(args); return { id: '8', created: true };
  } });
  const response = await fetch(`${url}/test`, { method: 'POST', headers, body: JSON.stringify({ text: 'Проба', max_id: 12 }) });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).audience, 'test');
  assert.deepEqual(calls, [['notice-test-01', 'Проба', { audience: 'test', maxId: '12' }]]);
  for (const max_id of [undefined, '', 0, -1, true, '12 OR 1', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await fetch(`${url}/test`, { method: 'POST', headers, body: JSON.stringify({ text: 'Проба', max_id }) })).status, 400);
  }
  assert.equal(calls.length, 1, 'Неверный MAX ID не превращает тест в рассылку всем');
  assert.equal((await fetch(`${url}/test`, { method: 'POST', body: '{}' })).status, 401);
});
