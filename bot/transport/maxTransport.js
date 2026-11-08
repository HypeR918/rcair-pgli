import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MAX_UPDATE_TYPES, validateTransportConfig } from './config.js';
import { createMaxApi } from './maxApi.js';
import { WebhookContext } from './webhookContext.js';
import { createDispatcher } from './updateDispatcher.js';
import { createWebhookDiagnostics } from './webhookDiagnostics.js';
import { createOperationScope } from '../utils/operationContext.js';

const MAX_BODY_BYTES = 1024 * 1024;

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

export async function startMaxTransport(bot, config, options = {}) {
  const transport = validateTransportConfig(config);
  const paths = new Set([transport.path]);
  if (transport.path !== '/') {
    paths.add(transport.path.endsWith('/') ? transport.path.slice(0, -1) : `${transport.path}/`);
  }
  const api = options.api || createMaxApi(config.BOT_TOKEN);
  const logger = options.logger || console;
  const onFatal = options.onFatal || (error => {
    logger.error('MAX transport fatal error:', error.message);
    process.exit(1);
  });
  if (!options.existingSubscription) {
    const subscriptions = await api('GET', '/subscriptions');
    if (!Array.isArray(subscriptions?.subscriptions)) {
      throw new Error('MAX не вернул список подписок');
    }
    if (subscriptions.subscriptions.some(item => item.url !== transport.url)) {
      throw new Error('У бота есть другой webhook. Сначала явно перенесите или удалите старую подписку MAX');
    }
    bot.botInfo = await api('GET', '/me');
    if (!bot.botInfo?.user_id) throw new Error('MAX не подтвердил учётную запись бота');
  }

  let ready = false;
  let accepting = false;
  const dispatch = createDispatcher(bot);
  const diagnostics = createWebhookDiagnostics(logger);
  const server = http.createServer(async (req, res) => {
    // Query-параметры не влияют на маршрут; полезно для внешней проверки Nginx.
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      reply(res, ready ? 200 : 503, { ok: ready, service: 'max-bot', transport: transport.mode });
      return;
    }
    if (req.method === 'GET' && path === '/diagnostics') {
      reply(res, 200, { ready, ...diagnostics.snapshot(), ...(options.queueSnapshot && { queue: options.queueSnapshot() }) });
      return;
    }
    if (options.adminApi && await options.adminApi(req, res)) return;
    if (!paths.has(path)) {
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
    const event = diagnostics.begin();
    const incoming = Buffer.from(req.headers['x-max-bot-api-secret'] || '');
    const expected = Buffer.from(transport.secret);
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
      req.resume();
      reply(res, 403, { ok: false });
      diagnostics.finish(event, { status: 403, reason: 'secret' });
      return;
    }
    diagnostics.authorize();
    if (!accepting) {
      req.resume();
      reply(res, 503, { ok: false });
      diagnostics.finish(event, { status: 503, reason: 'stopping' });
      return;
    }
    let operation;
    diagnostics.setPhase(event, 'http.body');
    try {
      const update = await readUpdate(req);
      const supported = MAX_UPDATE_TYPES.includes(update.update_type);
      // Только метаданные: без текста, MAX ID, callback payload и заголовка секрета.
      const ctx = supported ? new WebhookContext(update, bot.api, bot.botInfo) : null;
      const start = typeof update.message?.body?.text === 'string'
        && /^\/start(?:@\S+)?(?:\s|$)/.test(update.message.body.text.trim());
      diagnostics.received(event, {
        type: supported ? update.update_type : 'unsupported',
        start, has_user: Boolean(ctx?.user?.user_id),
      });
      operation = createOperationScope(
        phase => diagnostics.setPhase(event, phase),
        result => diagnostics.reply(event, result),
      );
      const result = supported ? await operation.run(async () => {
        if (!options.acceptUpdate) return dispatch(ctx); // Изолированный direct-test harness.
        const saved = await options.acceptUpdate(update);
        diagnostics.persisted(event, saved);
        return saved.duplicate ? 'duplicate' : 'queued';
      }) : 'ignored';
      const body = { ok: true };
      if (update.update_type === 'diagnostic_probe'
          && typeof update.probe_id === 'string' && /^[a-f0-9-]{36}$/.test(update.probe_id)) {
        body.probe_id = update.probe_id;
        body.instance_id = diagnostics.snapshot().instance_id;
      }
      reply(res, 200, body);
      diagnostics.finish(event, { result, status: 200 });
    } catch (error) {
      req.resume();
      const status = error instanceof WebhookRequestError || error.code === 'EVENT_STORE_UNAVAILABLE' ? error.status : 500;
      if (status === 500) logger.error('Ошибка MAX webhook:', error.message);
      if (!res.destroyed && !res.headersSent) reply(res, status, { ok: false });
      diagnostics.finish(event, { status, phase: operation?.failedPhase });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  async function stop() {
    ready = false;
    accepting = false;
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
        // Обработчики/БД уже подготовлены. Действующая подписка может прислать
        // событие, пока API ещё отвечает на повторную регистрацию.
        accepting = true;
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', onFatal);
    if (!options.existingSubscription) {
      const result = await api('POST', '/subscriptions', {
        url: transport.url,
        update_types: MAX_UPDATE_TYPES,
        secret: transport.secret,
      });
      if (result?.success !== true) throw new Error('MAX не подтвердил регистрацию webhook');
      logger.log('MAX webhook зарегистрирован:', transport.url);
    } else {
      logger.log('MAX webhook: используется существующая подписка:', transport.url);
    }
    ready = true;
    logger.log(`HTTP-сервер MAX-бота: порт ${server.address().port}, transport=${transport.mode}`);
    return { server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
