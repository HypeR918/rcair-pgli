// SDK обрабатывает обновления параллельно. Диалоги одного пользователя — последовательно.
const pending = new Map();
export async function serializeUserUpdates(ctx, next) {
  if (!ctx.user?.user_id) return next();
  const key = String(ctx.user.user_id);
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  pending.set(key, current);
  await previous;
  try { return await next(); }
  finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
