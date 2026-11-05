// Диагностика использует только уже переданные контейнеру настройки; .env не открывается.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MAX_UPDATE_TYPES, validateTransportConfig } from '../transport/config.js';
import { createMaxApi } from '../transport/maxApi.js';

function requestJSON(protocol, options, body) {
  return new Promise((resolve, reject) => {
    const req = protocol.request({ ...options, signal: AbortSignal.timeout(5000) }, async res => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('Слишком большой ответ диагностики');
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function diagnoseWebhook({
  config, api, localOnly = false, watchSeconds = 30, log = console.log,
  nginxHost = 'nginx', nginxPort = 443, ca,
}) {
  const transport = validateTransportConfig(config);
  if (!Number.isSafeInteger(watchSeconds) || watchSeconds < 0 || watchSeconds > 300) {
    throw new Error('Время наблюдения: целое число от 0 до 300 секунд');
  }
  let ok = true;
  const node = { hostname: '127.0.0.1', port: config.PORT };
  const snapshot = async () => {
    const result = await requestJSON(http, { ...node, path: '/diagnostics' });
    if (result.status !== 200 || typeof result.data?.received !== 'number' || !result.data?.instance_id) {
      throw new Error('В контейнере нет новой диагностики; проверьте версию образа');
    }
    return result.data;
  };
  log('Проверка локальной цепочки webhook; подписка и сообщения MAX не изменяются.');
  if (!localOnly) {
    try {
      if (!config.BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
      const call = api || createMaxApi(config.BOT_TOKEN);
      const [me, data] = await Promise.all([call('GET', '/me'), call('GET', '/subscriptions')]);
      log(`Бот: ${me.username || '(username не указан)'}`);
      const subs = data.subscriptions;
      if (!Array.isArray(subs)) throw new Error('MAX не вернул список подписок');
      log(`Подписок: ${subs.length}`);
      const match = subs.length === 1 && subs[0].url === transport.url
        && MAX_UPDATE_TYPES.every(type => subs[0].update_types?.includes(type));
      log(`Подписка на ожидаемый URL и три события: ${match ? 'ДА' : 'НЕТ'}`);
      ok &&= match;
    } catch (error) {
      ok = false;
      log(`Проверка MAX API: ${error.message}`);
    }
  }
  const baseline = await snapshot();
  const headers = { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': transport.secret };
  const callback = new URL(transport.url);
  const statuses = { node_status: null, nginx_status: null };
  for (const [name, protocol, target] of [
    ['node', http, node],
    ['nginx', https, {
      hostname: nginxHost, port: nginxPort, servername: callback.hostname,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(callback.hostname, cert),
      ...(ca && { ca }),
    }],
  ]) {
    try {
      const probeId = randomUUID();
      const probe = JSON.stringify({ update_type: 'diagnostic_probe', timestamp: Date.now(), probe_id: probeId });
      const response = await requestJSON(protocol, {
        ...target, method: 'POST', path: callback.pathname,
        headers: { ...headers, Host: callback.host },
      }, probe);
      statuses[`${name}_status`] = response.status;
      const passed = response.status === 200 && response.data?.ok === true
        && response.data.probe_id === probeId && response.data.instance_id === baseline.instance_id;
      ok &&= passed;
      log(`${name === 'node' ? 'Node callback' : 'Nginx HTTPS → callback'}: HTTP ${response.status}, ${passed ? 'OK' : 'ОШИБКА'}`);
    } catch (error) {
      ok = false;
      log(`${name}: ошибка ${error.code || 'CONNECTION_FAILED'}`);
    }
  }
  const before = await snapshot();
  if (watchSeconds) {
    log(`В течение ${watchSeconds} секунд отправьте новый /start в MAX.`);
    await delay(watchSeconds * 1000);
  }
  const after = watchSeconds ? await snapshot() : before;
  if (!after.ready || after.instance_id !== baseline.instance_id || after.uptime_ms < before.uptime_ms) {
    ok = false;
    log('Бот не готов или перезапустился во время проверки.');
  }
  const events = MAX_UPDATE_TYPES.reduce((sum, type) => sum + after.types[type] - before.types[type], 0);
  log(`Счётчики: вход=${after.received}, отказ=${after.rejected}, ошибки=${after.failed}, активные=${after.active}, старейший=${after.oldest_active_ms} мс`);
  if (watchSeconds) {
    log(`Событий трёх типов MAX за окно наблюдения: ${events}. Диагностические пробы сюда не включены.`);
    if (!events && ok) {
      log('Локальный POST через HTTPS работает; доставка события MAX за это время не зафиксирована. Внешний путь этой проверкой не подтверждён.');
    }
  }
  return { ok, ...statuses, snapshot: after, observed_events: events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.some((arg, i) => arg !== '--local-only' && arg !== '--watch' && args[i - 1] !== '--watch')) {
      throw new Error('Использование: node scripts/diagnose-webhook.mjs [--local-only] [--watch 0..300]');
    }
    const watchIndex = args.indexOf('--watch');
    const result = await diagnoseWebhook({
      config: {
        BOT_TOKEN: process.env.BOT_TOKEN, BOT_TRANSPORT: process.env.BOT_TRANSPORT,
        PORT: Number(process.env.PORT || 3000), WEBHOOK_URL: process.env.WEBHOOK_URL?.trim(),
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
      },
      localOnly: args.includes('--local-only'),
      watchSeconds: watchIndex < 0 ? 30 : Number(args[watchIndex + 1]),
    });
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error('Диагностика не завершена:', error.message);
    process.exitCode = 1;
  }
}
