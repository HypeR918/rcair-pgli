import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createImporterServer } from '../glpi-importer.js';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import * as db from '../services/dbService.js';
const dbStub = () => Object.fromEntries(Object.keys(db).map(name => [name, noop]));

test('сбой уведомления или отсутствие импортированного пользователя оставляют СДС для повторной обработки', async () => {
  let approved = 0; let linked = 0;
  const module = await loadIsolated('controllers/sdsController.js', {
    './services/dbService.js': { ...dbStub(), approveSdsRequest: async () => { approved++; },
      linkMaxIdToGlpiUser: async () => { linked++; }, findGlpiUserByMaxId: async () => ({ id: 42 }) },
    './services/sdsService.js': { importUserFromSdsViaGlpi: async () => ({ id: 42 }) },
    './controllers/userController.js': { showWelcomeAndMenu: noop },
  });
  const request = { id: 1, max_id: 101, email: 'fixture@example.test' };
  await assert.rejects(module.handleApprovedSdsRequest({ api: { sendMessageToUser: async () => { throw Error('MAX unavailable'); } } }, request));
  assert.equal(approved, 0); assert.equal(linked, 1);
  await module.handleApprovedSdsRequest({ api: { sendMessageToUser: noop } }, request);
  assert.equal(approved, 1); assert.equal(linked, 2);
  const missing = await loadIsolated('controllers/sdsController.js', {
    './services/dbService.js': { ...dbStub(), approveSdsRequest: async () => { approved++; } },
    './services/sdsService.js': { importUserFromSdsViaGlpi: async () => null },
    './controllers/userController.js': { showWelcomeAndMenu: noop },
  });
  await assert.rejects(missing.handleApprovedSdsRequest({ api: { sendMessageToUser: noop } }, request));
  assert.equal(approved, 1);
});

test('очередь СДС обходит более 20 незавершённых заявок; 404 не означает одобрение', async () => {
  const checked = []; const missing = [];
  const requests = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, glpi_ticket_id: index + 1, polling_max_id: 45 }));
  const poller = await loadIsolated('polling/sdsPolling.js', {
    './services/dbService.js': { ...dbStub(), getPendingSdsRequests: async (limit, afterId) => requests.filter(row => row.id > afterId).slice(0, limit),
      markSdsRequestMissing: async id => missing.push(id) },
    './services/glpiService.js': { getTicketDecision: async id => { checked.push(id); if (id === 22) throw Object.assign(Error('GLPI API request failed: 404'), { status: 404 }); if (id === 23) throw Error('Учётная запись ещё не найдена'); return { isFinal: false }; } },
    './controllers/sdsController.js': { handleApprovedSdsRequest: noop, handleRejectedSdsRequest: noop },
  });
  await poller.pollPendingSdsRequests({});
  assert.deepEqual(checked, requests.map(row => row.id));
  assert.deepEqual(missing, [22]);
});

test('importer требует секрет, проверяет авторизацию и email, ограничивает параллелизм и скрывает stdout', async () => {
  assert.throws(() => createImporterServer({ secret: '' }), /обязателен/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let running;
  const entered = new Promise(resolve => { running = resolve; });
  let calls = 0;
  const server = createImporterServer({ secret: 'synthetic-test-secret', runImport: async () => {
    calls++; running(); await gate; return { stdout: 'sensitive stdout' };
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/internal/import-ldap-user`;
  const request = (body, authorized = true) => fetch(url, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer synthetic-test-secret' } : {}) } });
  try {
    assert.equal((await request('{"email":"fixture@example.test"}', false)).status, 403);
    assert.equal((await request('{')).status, 400);
    assert.equal((await request('{"email":"invalid"}')).status, 400);
    const first = request('{"email":"fixture@example.test"}');
    await entered;
    assert.equal((await request('{"email":"other@example.test"}')).status, 429);
    release(); const response = await first;
    assert.deepEqual(await response.json(), { ok: true }); assert.equal(calls, 1);
  } finally {
    release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('ошибка importer не возвращает вывод команды клиенту', async () => {
  const server = createImporterServer({ secret: 'synthetic', runImport: async () => {
    const error = Error('sensitive command'); error.stdout = 'secret data'; throw error;
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/import-ldap-user`, {
      method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: '{"email":"fixture@example.test"}',
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: 'import_failed' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
