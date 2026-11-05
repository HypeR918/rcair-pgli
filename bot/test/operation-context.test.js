import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationScope, withOperation } from '../utils/operationContext.js';

test('этап относится к конечной ошибке, а не к ранее обработанному исключению', async () => {
  const scope = createOperationScope(() => {});
  const terminal = new Error('terminal');
  await assert.rejects(scope.run(async () => {
    try { await withOperation('glpi.api', () => { throw new Error('handled'); }); } catch {}
    await withOperation('max.api', () => { throw terminal; });
  }), error => error === terminal);
  assert.equal(scope.failedPhase, 'max.api');
});

test('обработанная ошибка не делает успешную обработку ошибочной', async () => {
  const scope = createOperationScope(() => {});
  await scope.run(async () => {
    try { await withOperation('glpi.api', () => { throw new Error('handled'); }); } catch {}
  });
  assert.equal(scope.failedPhase, null);
});

test('внешние обёртки сохраняют самый глубокий этап того же исключения', async () => {
  const scope = createOperationScope(() => {});
  await assert.rejects(scope.run(() => withOperation('dialog.handler', () =>
    withOperation('db.bot.execute', () => { throw new Error('database failed'); }))));
  assert.equal(scope.failedPhase, 'db.bot.execute');
});
