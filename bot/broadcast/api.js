import { timingSafeEqual } from 'node:crypto';
import { normalizeTestRecipient } from './validation.js';

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createBroadcastApi(store, secret = '') {
  if (secret && !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Некорректный BROADCAST_API_SECRET');
  return async (req, res) => {
    const path = req.url.split('?')[0];
    const isTest = path === '/internal/broadcasts/test';
    const isCreate = path === '/internal/broadcasts' || isTest;
    const match = /^\/internal\/broadcasts\/([1-9][0-9]{0,19})$/.exec(path);
    if (!isCreate && !match) return false;
    if (!secret) { req.resume(); reply(res, 404, { ok: false }); return true; }
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      req.resume(); reply(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return true;
    }
    if (req.method !== (isCreate ? 'POST' : 'GET')) {
      req.resume(); res.setHeader('Allow', isCreate ? 'POST' : 'GET');
      reply(res, 405, { ok: false }); return true;
    }
    try {
      if (!isCreate) {
        const status = await store.status(match[1]);
        reply(res, status ? 200 : 404, status || { ok: false, code: 'NOT_FOUND' });
        return true;
      }
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(key)
          || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        req.resume(); reply(res, 400, { ok: false, code: 'INVALID_REQUEST' }); return true;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 32768) { req.resume(); reply(res, 413, { ok: false }); return true; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { reply(res, 400, { ok: false, code: 'INVALID_JSON' }); return true; }
      const allowed = isTest ? ['text', 'max_id'] : ['text'];
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))
          || typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 4000) {
        reply(res, 400, { ok: false, code: 'INVALID_TEXT' }); return true;
      }
      const job = isTest
        ? await store.create(key, body.text, { audience: 'test', maxId: normalizeTestRecipient(body.max_id) })
        : await store.create(key, body.text);
      reply(res, 202, { ...job, ...(isTest && { audience: 'test' }), status_url: `/internal/broadcasts/${job.id}` });
    } catch (error) {
      req.resume();
      const statuses = { BROADCAST_KEY_CONFLICT: 409, BROADCAST_INVALID_RECIPIENT: 400, BROADCAST_RECIPIENT_NOT_FOUND: 404 };
      reply(res, Object.hasOwn(statuses, error.code) ? statuses[error.code] : 503,
        { ok: false, code: Object.hasOwn(statuses, error.code) ? error.code : 'BROADCAST_UNAVAILABLE' });
    }
    return true;
  };
}
