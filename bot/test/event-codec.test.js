import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventCodec } from '../queue/eventCodec.js';

const message = (mid = 'private.mid') => ({ update_type: 'message_created', timestamp: 1,
  message: { sender: { user_id: 123 }, body: { mid, text: '123456 private@example.invalid' } } });

test('payload событий зашифрован; изменение ciphertext/AAD/ключа обнаруживается', () => {
  const codec = createEventCodec('a'.repeat(64));
  const update = message();
  const identity = codec.identify(update);
  const encrypted = codec.encode(update, identity.eventKey);
  assert.deepEqual(codec.decode(encrypted, identity.eventKey), update);
  for (const secret of ['123456', 'private.mid', 'private@example.invalid']) assert(!encrypted.includes(Buffer.from(secret)));
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => codec.decode(damaged, identity.eventKey), /EVENT_PAYLOAD_INVALID/);
  assert.throws(() => codec.decode(encrypted, Buffer.alloc(32)), /EVENT_PAYLOAD_INVALID/);
  assert.throws(() => createEventCodec('b'.repeat(64)).decode(encrypted, identity.eventKey), /EVENT_PAYLOAD_INVALID/);
});

test('mid/callback/start дедуплицируются; пользователь имеет общий непрозрачный ключ', () => {
  const codec = createEventCodec('a'.repeat(64));
  const a = codec.identify(message());
  const b = codec.identify(message('another.mid'));
  assert(a.userKey.equals(b.userKey));
  assert(!a.eventKey.equals(b.eventKey));
  assert(a.eventKey.equals(codec.identify({ timestamp: 9, ...message() }).eventKey));
  const callback = { update_type: 'message_callback', timestamp: 2, callback: { callback_id: 'callback.1', user: { user_id: 123 } } };
  assert(codec.identify(callback).userKey.equals(a.userKey));
  const start = { update_type: 'bot_started', timestamp: 3, chat_id: 456, user: { user_id: 123 }, payload: 'private' };
  assert(codec.identify(start).eventKey.equals(codec.identify({ ...start, user: { first_name: 'changed', user_id: 123 } }).eventKey));
  assert(!codec.identify(start).eventKey.equals(codec.identify({ ...start, timestamp: 4 }).eventKey));
  const sds = { update_type: 'sds_approved', timestamp: 0, user: { user_id: 123 }, request: { id: 7, polling_max_id: 20 } };
  assert(codec.identify(sds).eventKey.equals(codec.identify({ ...sds, request: { ...sds.request, polling_max_id: 30 } }).eventKey));
});
