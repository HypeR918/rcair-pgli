export const MAX_API_URL = 'https://platform-api2.max.ru';
export const MAX_UPDATE_TYPES = ['message_created', 'message_callback', 'bot_started'];
export const MAX_POLLING_DISABLED_MESSAGE = 'Опрос MAX через /updates запрещён: основной бот использует только webhook';

export function assertWebhookApiPath(path) {
  const url = new URL(String(path), MAX_API_URL);
  if (decodeURIComponent(url.pathname).replace(/\/+$/, '') === '/updates') {
    throw new Error(MAX_POLLING_DISABLED_MESSAGE);
  }
}

export function validateTransportConfig(config) {
  const mode = String(config.BOT_TRANSPORT || 'webhook').trim().toLowerCase();
  if (mode !== 'webhook') {
    throw new Error('Основной бот поддерживает только BOT_TRANSPORT=webhook; long polling MAX отключён');
  }
  if (!Number.isSafeInteger(config.PORT) || config.PORT < 1 || config.PORT > 65535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535');
  }
  let url;
  try { url = new URL(config.WEBHOOK_URL); } catch {
    throw new Error('Для webhook задайте WEBHOOK_URL с публичным HTTPS-адресом');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname === '/health') {
    throw new Error('WEBHOOK_URL должен быть HTTPS-адресом без учётных данных, query и fragment; /health зарезервирован');
  }
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(config.WEBHOOK_SECRET || '')) {
    throw new Error('WEBHOOK_SECRET должен содержать 5–256 символов A-Z, a-z, 0-9, _ или -');
  }
  return { mode, url: url.href, path: url.pathname, secret: config.WEBHOOK_SECRET };
}
