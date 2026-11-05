import { createHash } from 'node:crypto';
import { withOperation } from '../utils/operationContext.js';

const DEDUP_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_UPDATES = 10000;

function updateKey(update) {
  if (update.update_type === 'bot_started' && update.user?.user_id && update.chat_id != null) {
    // У старта нет mid. Хеш сохраняет идентичность повтора без хранения payload в ключе.
    const identity = [update.timestamp, update.chat_id, update.user.user_id, update.payload ?? ''];
    return `bot_started:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  }
  const id = update.update_type === 'message_created' ? update.message?.body?.mid
    : update.update_type === 'message_callback' ? update.callback?.callback_id : null;
  return typeof id === 'string' && id ? `${update.update_type}:${id}` : null;
}

export function createDispatcher(bot) {
  const active = new Map();
  const completed = new Map();
  return async ctx => {
    const key = updateKey(ctx.update);
    const now = Date.now();
    for (const [id, time] of completed) {
      if (now - time < DEDUP_TTL_MS) break;
      completed.delete(id);
    }
    if (key && completed.has(key)) return 'duplicate';
    if (key && active.has(key)) {
      await withOperation('event.duplicate_wait', () => active.get(key));
      return 'duplicate';
    }

    const task = Promise.resolve().then(async () => {
      // Публичный middleware SDK сохраняет обработчики и сериализацию MAX ID.
      await bot.middleware()(ctx, () => Promise.resolve());
      if (key) {
        completed.set(key, Date.now());
        if (completed.size > MAX_RECENT_UPDATES) completed.delete(completed.keys().next().value);
      }
    });
    if (key) active.set(key, task);
    try { await task; return 'processed'; } finally { if (key) active.delete(key); }
  };
}
