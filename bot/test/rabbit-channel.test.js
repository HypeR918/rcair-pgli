import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadIsolated } from './helpers/isolated.mjs';

async function fixture() {
  const connection = new EventEmitter();
  const publish = new EventEmitter();
  const consume = new EventEmitter();
  let closeCount = 0;
  let confirm;
  let sent;
  publish.assertQueue = async () => {};
  publish.sendToQueue = (queue, body, properties, callback) => { sent = { queue, body, properties }; confirm = callback; };
  consume.prefetch = async () => {};
  connection.createConfirmChannel = async () => publish;
  connection.createChannel = async () => consume;
  connection.close = async () => { closeCount++; connection.emit('close'); };
  const module = await loadIsolated('queue/rabbit.js', { amqplib: { default: { connect: async () => connection } } });
  let lost = 0;
  const rabbit = await module.connectRabbit({ url: 'amqp://offline:private@fixture', queue: 'test' }, { onClose: () => { lost++; } });
  return { rabbit, publish, consume, getLost: () => lost, getClosed: () => closeCount, getSent: () => sent, confirm: error => confirm(error) };
}

for (const channel of ['publish', 'consume']) {
  test(`закрытие ${channel}-канала отключает клиента и запускает recovery при живом connection`, async () => {
    const f = await fixture();
    assert.equal(f.rabbit.connected, true);
    f[channel].emit('close');
    assert.equal(f.rabbit.connected, false);
    assert.equal(f.getLost(), 1);
    assert.equal(f.getClosed(), 1);
    await f.rabbit.close();
    assert.equal(f.getLost(), 1);
  });
}

test('публикация ждёт publisher confirm, отправляет только ID и не раскрывает ошибку с URL', async () => {
  const f = await fixture();
  let complete = false;
  const sending = f.rabbit.publish('7').then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false);
  assert.equal(f.getSent().body.toString(), '{"id":"7"}');
  assert.equal(f.getSent().properties.persistent, true);
  f.confirm(); await sending;
  const failed = f.rabbit.publish('8');
  f.confirm(new Error('amqp://offline:private@fixture'));
  await assert.rejects(failed, error => !String(error.stack).includes('private'));
  await f.rabbit.close();
});
