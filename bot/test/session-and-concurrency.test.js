import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import { serializeUserUpdates } from '../utils/userUpdates.js';

test('ошибка БД не меняет сохранённую сессию; изменения копии не затрагивают кэш', async () => {
  let fail = false;
  const store = await loadIsolated('state/sessionStore.js', {
    './services/dbService.js': { pool: { execute: async () => {
      if (fail) throw new Error('DB unavailable');
      return [[]];
    } } },
  });
  await store.setSession(123, { state: 'old', ticketDraft: { files: [] } });
  const copy = store.getSession('123');
  copy.state = 'mutated';
  assert.equal(store.getSession(123).state, 'old');
  fail = true;
  await assert.rejects(store.setSession(123, { state: 'new' }), /DB unavailable/);
  await assert.rejects(store.deleteSession(123), /DB unavailable/);
  assert.equal(store.getSession(123).state, 'old');
});

test('загрузка сессии BIGINT как строки совместима с числовым MAX ID', async () => {
  const store = await loadIsolated('state/sessionStore.js', {
    './services/dbService.js': { pool: { execute: async () => [[{ max_id: '123', session_data: '{"state":"ready"}' }]] } },
  });
  await store.loadAllSessions();
  assert.equal(store.getSession(123).state, 'ready');
});

test('обновления одного пользователя последовательны, другие пользователи не блокируются', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = serializeUserUpdates({ user: { user_id: 1 } }, async () => {
    events.push('first'); await gate; events.push('done');
  });
  const second = serializeUserUpdates({ user: { user_id: 1 } }, async () => events.push('second'));
  await serializeUserUpdates({ user: { user_id: 2 } }, async () => events.push('other'));
  assert.deepEqual(events, ['first', 'other']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'done', 'second']);
  await assert.rejects(serializeUserUpdates({ user: { user_id: 1 } }, async () => { throw Error('failed'); }));
  await serializeUserUpdates({ user: { user_id: 1 } }, noop);
});
