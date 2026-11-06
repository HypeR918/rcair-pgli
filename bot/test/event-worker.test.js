import test from 'node:test';
import assert from 'node:assert/strict';
import { startEventWorker } from '../queue/worker.js';

test('остановка worker ждёт незавершённый claim и не запускает handler после stop', async () => {
  let receive;
  let release;
  let handlers = 0;
  const claim = new Promise(resolve => { release = resolve; });
  const rabbit = { connected: true, consume: async callback => { receive = callback; }, cancel: async () => {}, close: async () => {} };
  const worker = await startEventWorker({ claim: () => claim, markStarted: async () => true,
    complete: async () => true }, rabbit, async () => { handlers++; }, { logger: { log() {}, error() {} } });
  const delivery = receive('1');
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'stop должен учитывать ещё не завершённый SQL claim');
  release({ id: '1', update: {} });
  await Promise.all([stopping, delivery]);
  assert.equal(handlers, 0);
});

test('worker отдельно измеряет очередь и обработку; payload не попадает в лог', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let receive;
  const logs = [];
  const rabbit = { connected: true, consume: async callback => { receive = callback; }, cancel: async () => {}, close: async () => {} };
  const worker = await startEventWorker({
    claim: async () => ({ id: '1', queueWaitMs: 375, update: {
      update_type: 'message_callback', callback: { payload: 'private@example.invalid' },
    } }),
    markStarted: async () => true, complete: async () => true,
  }, rabbit, async () => { t.mock.timers.tick(125); }, {
    logger: { log: (_tag, body) => logs.push(JSON.parse(body)), error() {} },
  });
  t.after(() => worker.stop());
  await receive('1');
  assert.equal(logs[0].queue_wait_ms, 375);
  assert.equal(logs[0].duration_ms, 125);
  assert.equal(logs[0].total_ms, 500);
  assert.equal(logs[0].type, 'message_callback');
  assert(!JSON.stringify(logs).includes('private@example.invalid'));
});
