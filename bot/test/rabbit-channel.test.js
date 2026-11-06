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
  let receive;
  let cancellations = 0;
  publish.assertQueue = async () => {};
  publish.sendToQueue = (queue, body, properties, callback) => { sent = { queue, body, properties }; confirm = callback; };
  consume.prefetch = async () => {};
  consume.consume = async (_queue, callback) => { receive = callback; return { consumerTag: 'fixture' }; };
  consume.cancel = async () => { cancellations++; };
  connection.createConfirmChannel = async () => publish;
  connection.createChannel = async () => consume;
  connection.close = async () => { closeCount++; connection.emit('close'); };
  const module = await loadIsolated('queue/rabbit.js', { amqplib: { default: { connect: async () => connection } } });
  let lost = 0;
  const rabbit = await module.connectRabbit({ url: 'amqp://offline:private@fixture', queue: 'test' }, { onClose: () => { lost++; } });
  return { rabbit, connection, publish, consume, getLost: () => lost, getClosed: () => closeCount, getSent: () => sent,
    getCancelled: () => cancellations, cancelFromServer: () => receive(null), confirm: error => confirm(error) };
}

test('server cancel отключает consumer; stop не ждёт cancel/close уже закрывающегося брокера', async () => {
  const f = await fixture();
  await f.rabbit.consume(() => {});
  f.cancelFromServer();
  assert.equal(f.rabbit.connected, false);
  assert.equal(f.getLost(), 1);
  await f.rabbit.cancel(); await f.rabbit.close();
  assert.equal(f.getCancelled(), 0);
  assert.equal(f.getClosed(), 1);
});

test('cancel и close ограничены по времени, если брокер не ответил на AMQP RPC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture();
  await f.rabbit.consume(() => {});
  f.consume.cancel = () => new Promise(() => {});
  const cancelling = assert.rejects(f.rabbit.cancel(), error => error.code === 'RABBITMQ_UNAVAILABLE');
  t.mock.timers.tick(2000); await cancelling;
  f.connection.close = () => new Promise(() => {});
  const closing = f.rabbit.close();
  t.mock.timers.tick(2000); await closing;
  assert.equal(f.rabbit.connected, false);
});

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
