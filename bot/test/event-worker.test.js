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
