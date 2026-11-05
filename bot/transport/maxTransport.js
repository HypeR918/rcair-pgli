import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Context } from '@maxhub/max-bot-api';
import { MAX_UPDATE_TYPES, validateTransportConfig } from './config.js';
import { createMaxApi } from './maxApi.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_UPDATES = 10000;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

class WebhookRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readUpdate(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new WebhookRequestError(415, 'Требуется application/json');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new WebhookRequestError(413, 'Слишком большой запрос');
  }
  const chunks = [];
  let size = 0;
  // Сохраняем сокет при досрочном выходе, чтобы успеть отправить ответ 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new WebhookRequestError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  let update;
  try { update = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new WebhookRequestError(400, 'Некорректный JSON');
  }
  if (!update || Array.isArray(update) || typeof update !== 'object'
      || typeof update.update_type !== 'string' || !Number.isFinite(update.timestamp)) {
    throw new WebhookRequestError(400, 'Некорректное событие MAX');
  }
  return update;
}

function updateKey(update) {
  const id = update.update_type === 'message_created' ? update.message?.body?.mid
    : update.update_type === 'message_callback' ? update.callback?.callback_id : null;
  return typeof id === 'string' && id ? `${update.update_type}:${id}` : null;
}

function createDispatcher(bot) {
  const active = new Map();
  const completed = new Map();
  return async update => {
    const key = updateKey(update);
    const now = Date.now();
    for (const [id, time] of completed) {
      if (now - time < DEDUP_TTL_MS) break;
      completed.delete(id);
    }
    if (key && completed.has(key)) return 'duplicate';
    if (key && active.has(key)) {
      await active.get(key);
      return 'duplicate';
    }

    const task = Promise.resolve().then(async () => {
      const ctx = new Context(update, bot.api, bot.botInfo);
      // Публичные Context/middleware сохраняют все хендлеры и сериализацию MAX ID.
      // bot.catch() относится к polling; здесь ошибка должна дать HTTP 500 для retry.
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

export async function startMaxTransport(bot, config, options = {}) {
  const transport = validateTransportConfig(config);
  const api = options.api || createMaxApi(config.BOT_TOKEN);
  const logger = options.logger || console;
  const onFatal = options.onFatal || (error => {
    logger.error('MAX transport fatal error:', error.message);
    process.exit(1);
  });
  const subscriptions = await api('GET', '/subscriptions');
  if (!Array.isArray(subscriptions?.subscriptions)) {
    throw new Error('MAX не вернул список подписок');
  }
  if (subscriptions.subscriptions.some(item => transport.mode === 'polling' || item.url !== transport.url)) {
    throw new Error('У бота есть другой webhook. Сначала явно перенесите или удалите старую подписку MAX');
  }
  bot.botInfo = await api('GET', '/me');
  if (!bot.botInfo?.user_id) throw new Error('MAX не подтвердил учётную запись бота');

  let ready = false;
  let stopping = false;
  let sequence = 0;
  const dispatch = createDispatcher(bot);
  const server = http.createServer(async (req, res) => {
    // Query-параметры не влияют на маршрут; полезно для внешней проверки Nginx.
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      reply(res, ready ? 200 : 503, { ok: ready, service: 'max-bot', transport: transport.mode });
      return;
    }
    if (transport.mode !== 'webhook' || path !== transport.path) {
      req.resume();
      reply(res, 404, { ok: false });
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('Allow', 'POST');
      reply(res, 405, { ok: false });
      return;
    }
    const incoming = Buffer.from(req.headers['x-max-bot-api-secret'] || '');
    const expected = Buffer.from(transport.secret);
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
      req.resume();
      reply(res, 403, { ok: false });
      return;
    }
    if (!ready) {
      req.resume();
      reply(res, 503, { ok: false });
      return;
    }
    let event;
    let receivedAt;
    try {
      const update = await readUpdate(req);
      event = ++sequence;
      receivedAt = Date.now();
      const supported = MAX_UPDATE_TYPES.includes(update.update_type);
      // Только метаданные: без текста, MAX ID, callback payload и заголовка секрета.
      const ctx = supported ? new Context(update, bot.api, bot.botInfo) : null;
      const start = typeof update.message?.body?.text === 'string'
        && /^\/start(?:@\S+)?(?:\s|$)/.test(update.message.body.text.trim());
      logger.log('[MAX_WEBHOOK]', JSON.stringify({
        event, stage: 'received', type: supported ? update.update_type : 'unsupported',
        start, has_user: Boolean(ctx?.user?.user_id),
      }));
      const result = supported ? await dispatch(update) : 'ignored';
      reply(res, 200, { ok: true });
      logger.log('[MAX_WEBHOOK]', JSON.stringify({
        event, stage: 'finished', result, status: 200, duration_ms: Date.now() - receivedAt,
      }));
    } catch (error) {
      req.resume();
      const status = error instanceof WebhookRequestError ? error.status : 500;
      if (status === 500) logger.error('Ошибка MAX webhook:', error.message);
      if (!res.destroyed) reply(res, status, { ok: false });
      logger.log('[MAX_WEBHOOK]', JSON.stringify({
        event: event ?? null, stage: 'failed', status,
        duration_ms: receivedAt === undefined ? 0 : Date.now() - receivedAt,
      }));
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  async function stop() {
    ready = false;
    stopping = true;
    if (transport.mode === 'polling') bot.stop();
    if (!server.listening) return;
    const deadline = setTimeout(() => server.closeAllConnections(), 15000);
    deadline.unref();
    try { await new Promise(resolve => server.close(resolve)); } finally { clearTimeout(deadline); }
    // Подписку сохраняем: MAX сможет повторить доставку после перезапуска.
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? config.PORT, options.host || '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', onFatal);
    if (transport.mode === 'webhook') {
      const result = await api('POST', '/subscriptions', {
        url: transport.url,
        update_types: MAX_UPDATE_TYPES,
        secret: transport.secret,
      });
      if (result?.success !== true) throw new Error('MAX не подтвердил регистрацию webhook');
      logger.log('MAX webhook зарегистрирован:', transport.url);
    } else {
      bot.start({ allowedUpdates: MAX_UPDATE_TYPES }).then(() => {
        if (!stopping) onFatal(new Error('MAX polling неожиданно завершился'));
      }).catch(error => { if (!stopping) onFatal(error); });
    }
    ready = true;
    logger.log(`HTTP-сервер MAX-бота: порт ${server.address().port}, transport=${transport.mode}`);
    return { server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
