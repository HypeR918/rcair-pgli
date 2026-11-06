import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export function createEventCodec(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Нужен EVENT_PAYLOAD_SECRET длиной не менее 32 символов');
  const key = Buffer.from(hkdfSync('sha256', secret, 'max-events-v1', 'payload-and-identity', 32));
  const hash = value => createHmac('sha256', key).update(value).digest();
  const userKey = id => hash(`user:${String(id)}`);
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
    : value;
  return {
    userKey,
    identify(update) {
      const type = update.update_type;
      const user = update.callback?.user?.user_id ?? update.user?.user_id ?? update.message?.sender?.user_id;
      const id = type === 'message_created' ? update.message?.body?.mid
        : type === 'message_callback' ? update.callback?.callback_id
        : ['sds_approved', 'sds_rejected'].includes(type) ? String(update.request?.id)
        : type === 'bot_started' ? [update.timestamp, update.chat_id, user, update.payload ?? ''] : null;
      const eventKey = hash(JSON.stringify([type, id || canonical(update)]));
      return { type, eventKey, userKey: user != null ? userKey(user) : hash(`orphan:${eventKey.toString('hex')}`) };
    },
    encode(update, eventKey) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(eventKey);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(update), 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
    },
    decode(payload, eventKey) {
      try {
        if (!Buffer.isBuffer(payload) || payload.length < 30 || payload[0] !== 1) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 13));
        decipher.setAAD(eventKey);
        decipher.setAuthTag(payload.subarray(13, 29));
        return JSON.parse(Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString('utf8'));
      } catch {
        const error = new Error('EVENT_PAYLOAD_INVALID'); error.code = 'EVENT_PAYLOAD_INVALID'; throw error;
      }
    },
  };
}
