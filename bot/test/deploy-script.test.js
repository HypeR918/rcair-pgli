import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../deploy/use-docker-nginx.sh', import.meta.url).pathname;

// Все системные команды подменены: тест не обращается к Docker/systemd/сети.
async function runScript(t, failure = '', action = 'switch') {
  const dir = await mkdtemp(join(tmpdir(), 'rcair-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await mkdir(join(dir, 'tls'));
  for (const cert of ['fullchain.pem', 'privkey.pem']) await writeFile(join(dir, 'tls', cert), '');
  const shim = `#!${process.execPath} --
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === 'id') { console.log('0'); process.exit(0); }
fs.appendFileSync(process.env.RCAIR_COMMAND_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'docker') {
  if (args[0] === 'inspect') console.log('healthy');
  if (args.includes('ps')) console.log('test-bot-id');
  if (args.includes(process.env.RCAIR_FAILURE)) process.exit(1);
}
if (name === 'curl' && args.includes('%{http_code}')) {
  process.stdout.write(process.env.RCAIR_FAILURE === 'tls' ? '503' : '403');
}
`;
  for (const name of ['id', 'docker', 'curl', 'systemctl']) {
    await writeFile(join(dir, 'bin', name), shim, { mode: 0o755 });
  }
  const logPath = join(dir, 'commands.jsonl');
  const inheritedEnv = { ...process.env };
  // Вспомогательные Node-команды не являются дочерними тестовыми процессами.
  delete inheritedEnv.NODE_TEST_CONTEXT;
  const result = spawnSync('bash', [script, action], {
    env: {
      ...inheritedEnv, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      MAX_BOT_DEPLOY_DIR: dir, MAX_BOT_TLS_DIR: join(dir, 'tls'),
      RCAIR_COMMAND_LOG: logPath, RCAIR_FAILURE: failure,
    }, encoding: 'utf8',
  });
  assert.ifError(result.error);
  const commandLog = await readFile(logPath, 'utf8').catch(error => {
    throw new Error(`Не создан журнал команд: ${result.stderr}`, { cause: error });
  });
  const commands = commandLog.trim().split('\n').map(line => JSON.parse(line));
  return { ...result, commands };
}

test('перенос Nginx: проверка до остановки хоста, запускается только nginx без зависимостей', async t => {
  const r = await runScript(t);
  assert.equal(r.status, 0, r.stderr);
  const index = predicate => r.commands.findIndex(predicate);
  const stopHost = index(c => c[0] === 'systemctl' && c[1] === 'stop');
  assert.ok(index(c => c.includes('pull')) < stopHost);
  assert.ok(index(c => c.includes('nginx') && c.includes('-t')) < stopHost);
  const up = r.commands.find(c => c.includes('up'));
  assert.ok(up.includes('--no-deps'));
  assert.equal(up.at(-1), 'nginx');
  assert.ok(index(c => c.includes('up')) > stopHost);
  assert.deepEqual(r.commands.at(-1), ['systemctl', 'disable', 'nginx']);
  assert.equal(r.commands.some(c => c.includes('down') || c.includes('restart')), false);
});

test('ошибка предварительной проверки не останавливает Nginx хоста', async t => {
  const r = await runScript(t, 'run');
  assert.notEqual(r.status, 0);
  assert.equal(r.commands.some(c => c[0] === 'systemctl'), false);
});

for (const failure of ['up', 'tls']) {
  test(`ошибка ${failure}: контейнер Nginx останавливается, хостовый возвращается`, async t => {
    const r = await runScript(t, failure);
    assert.notEqual(r.status, 0);
    assert.ok(r.commands.at(-2).includes('stop'));
    assert.equal(r.commands.at(-2).at(-1), 'nginx');
    assert.deepEqual(r.commands.at(-1), ['systemctl', 'enable', '--now', 'nginx']);
  });
}

test('явный откат возвращает Nginx на хосте без пересоздания бота/БД', async t => {
  const r = await runScript(t, '', 'rollback');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.commands.length, 2);
  assert.ok(r.commands[0].includes('stop'));
  assert.deepEqual(r.commands[1], ['systemctl', 'enable', '--now', 'nginx']);
});
