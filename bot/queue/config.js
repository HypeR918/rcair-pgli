export function readQueueConfig(values = process.env) {
  const role = values.BOT_ROLE || 'webhook';
  if (!['webhook', 'worker'].includes(role)) throw new Error('BOT_ROLE: webhook или worker');
  let url;
  try { url = new URL(values.RABBITMQ_URL); } catch { throw new Error('Нужен корректный RABBITMQ_URL'); }
  if (!['amqp:', 'amqps:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error('Некорректный RABBITMQ_URL');
  if (typeof values.EVENT_PAYLOAD_SECRET !== 'string' || values.EVENT_PAYLOAD_SECRET.length < 32) {
    throw new Error('Нужен постоянный EVENT_PAYLOAD_SECRET длиной не менее 32 символов');
  }
  const prefetch = Number(values.EVENT_WORKER_CONCURRENCY || 4);
  if (!Number.isSafeInteger(prefetch) || prefetch < 1 || prefetch > 16) throw new Error('EVENT_WORKER_CONCURRENCY: 1–16');
  const relayIntervalMs = Number(values.EVENT_RELAY_INTERVAL_MS ?? 200);
  if (!Number.isSafeInteger(relayIntervalMs) || relayIntervalMs < 100 || relayIntervalMs > 5000) {
    throw new Error('EVENT_RELAY_INTERVAL_MS: 100–5000 мс');
  }
  return { role, url: values.RABBITMQ_URL, secret: values.EVENT_PAYLOAD_SECRET, prefetch,
    relayIntervalMs, queue: values.EVENT_QUEUE_NAME || 'max.webhook.events.v1' };
}
