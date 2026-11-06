// SDK обрабатывает обновления параллельно. Диалоги одного пользователя — последовательно.
import { withOperation } from './operationContext.js';

const pending = new Map();
export async function runForUser(userId, next) {
  const key = String(userId);
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  pending.set(key, current);
  await withOperation('dialog.wait', () => previous);
  try { return await withOperation('dialog.handler', next); }
  finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

export async function serializeUserUpdates(ctx, next) {
  if (!ctx.user?.user_id) return next();
  return runForUser(ctx.user.user_id, next);
}
