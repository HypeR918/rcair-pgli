import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = new URL('../deploy/use-python-webhook.sh', import.meta.url).pathname;
const savedImage = `sha256:${'a'.repeat(64)}`;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rcair-python-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  const shim = `#!${process.execPath} --
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === 'id') { console.log('0'); process.exit(0); }
fs.appendFileSync(process.env.RCAIR_COMMAND_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') console.log(args.includes('{{.Image}}') ? '${savedImage}' : 'max-glpi-bot:webhook');
if (process.env.RCAIR_FAILURE === 'build' && args[0] === 'build') process.exit(1);
if (process.env.RCAIR_FAILURE === 'python-up' && args.includes('up') && args.some(a => a.endsWith('docker-compose.python.yml'))) process.exit(1);
if (process.env.RCAIR_FAILURE === 'diagnose' && args[0] === 'exec') process.exit(1);
`;
  for (const name of ['id', 'docker']) await writeFile(join(dir, 'bin', name), shim, { mode: 0o755 });
  const log = join(dir, 'commands.jsonl');
  const state = join(dir, '.python-webhook-state');
  const run = async (action = 'switch', failure = '') => {
    await writeFile(log, '');
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      MAX_BOT_DEPLOY_DIR: dir, RCAIR_COMMAND_LOG: log, RCAIR_FAILURE: failure };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('bash', [script, action], { env, encoding: 'utf8' });
    assert.ifError(result.error);
    const commands = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, commands };
  };
  return { run, state };
}

test('Python switch: сборка до остановки, заменяется только max-bot, образ Node сохраняется', async t => {
  const f = await fixture(t);
  const r = await f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await readFile(f.state, 'utf8')).trim(), savedImage);
  assert(r.commands.findIndex(c => c[0] === 'build') < r.commands.findIndex(c => c.includes('up')));
  const up = r.commands.find(c => c.includes('up'));
  assert(up.some(arg => arg.endsWith('docker-compose.python.yml')));
  assert(up.includes('--no-deps') && up.includes('--no-build') && up.includes('--wait'));
  assert.equal(up.at(-1), 'max-bot');
  assert(!r.commands.some(c => c.includes('down') || c.includes('stop')));
});

for (const failure of ['python-up', 'diagnose']) {
  test(`Python ${failure}: автоматический возврат к сохранённому Node-образу`, async t => {
    const f = await fixture(t);
    const r = await f.run('switch', failure);
    assert.notEqual(r.status, 0);
    const updates = r.commands.filter(c => c.includes('up'));
    assert.equal(updates.length, 2);
    assert(updates[0].some(a => a.endsWith('docker-compose.python.yml')));
    assert(!updates[1].some(a => a.endsWith('docker-compose.python.yml')));
    assert(updates.every(c => c.includes('--no-deps') && c.at(-1) === 'max-bot'));
    await assert.rejects(access(f.state));
  });
}

test('ошибка сборки Python сохраняет запущенного Node без пересоздания', async t => {
  const f = await fixture(t);
  const r = await f.run('switch', 'build');
  assert.notEqual(r.status, 0);
  assert(!r.commands.some(c => c.includes('up')));
  await assert.rejects(access(f.state));
});

test('явный rollback использует сохранённый образ и возвращает исходную конфигурацию', async t => {
  const f = await fixture(t);
  await writeFile(f.state, `${savedImage}\n`);
  const r = await f.run('rollback');
  assert.equal(r.status, 0, r.stderr);
  assert(!r.commands.some(c => c.some(a => a.endsWith('docker-compose.python.yml'))));
  assert(r.commands.some(c => c[0] === 'image' && c[1] === 'inspect' && c[2] === savedImage));
  const up = r.commands.find(c => c.includes('up'));
  assert(up.includes('--no-deps'));
  await assert.rejects(access(f.state));
});
