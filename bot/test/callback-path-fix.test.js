import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../deploy/fix-callback-path.sh', import.meta.url).pathname;
const config = 'server {\n  listen 443 ssl;\n  server_name bot-support.gov70.ru;\n  ssl_certificate /custom/tls/fullchain.pem;\n  location /max/callback/ { proxy_pass http://max_bot_backend; }\n}\n';
async function fixture(t, { text = config, failure = '', stale = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rcair-callback-fix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  const path = join(dir, 'nginx.conf');
  const log = join(dir, 'commands.jsonl');
  await writeFile(path, text);
  const shim = `#!${process.execPath} --
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(path.basename(process.argv[1])==='id'){console.log('0');process.exit(0);}
fs.appendFileSync(process.env.FIX_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='inspect')console.log(process.env.FIX_CONFIG);
if(args[2]==='cat')process.stdout.write(process.env.FIX_STALE?'stale config':fs.readFileSync(process.env.FIX_CONFIG,'utf8'));
if(args[2]==='nginx'&&args[3]==='-t'&&process.env.FIX_FAILURE==='syntax')process.exit(1);
`;
  for (const name of ['id', 'docker']) await writeFile(join(dir, 'bin', name), shim, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FIX_CONFIG: path,
    FIX_LOG: log, FIX_FAILURE: failure, FIX_STALE: stale ? '1' : '' };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync('bash', [script, 'fixture-nginx'], { env, encoding: 'utf8' });
  return { run, dir, path, log, text };
}

test('hotfix сохраняет новый домен/TLS, создаёт backup и повторяется без дублирования location', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const updated = await readFile(f.path, 'utf8');
  assert(updated.includes('server_name bot-support.gov70.ru;'));
  assert(updated.includes('ssl_certificate /custom/tls/fullchain.pem;'));
  assert(updated.includes('rewrite ^ /max/callback/ last;'));
  const backups = (await readdir(f.dir)).filter(name => name.includes('.bak-callback.'));
  assert.equal(await readFile(join(f.dir, backups[0]), 'utf8'), config);
  assert.equal(f.run().status, 0);
  assert.equal(await readFile(f.path, 'utf8'), updated);
});

test('неудачный nginx -t восстанавливает файл без reload', async t => {
  const f = await fixture(t, { failure: 'syntax' });
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(f.path, 'utf8'), f.text);
  assert(!(await readFile(f.log, 'utf8')).includes('reload'));
});

test('неизвестный bare location и устаревший bind не перезаписываются', async t => {
  for (const options of [{ text: config.replace('  location /max', '  location = /max/callback { proxy_pass http://custom; }\n  location /max') }, { stale: true }]) {
    const f = await fixture(t, options);
    assert.notEqual(f.run().status, 0);
    assert.equal(await readFile(f.path, 'utf8'), f.text);
  }
});

test('явный return301 у bare location заменяется только внутренним rewrite', async t => {
  const text = config.replace('  location /max', '  location = /max/callback { return 301 /max/callback/; }\n  location /max');
  const f = await fixture(t, { text });
  assert.equal(f.run().status, 0);
  const updated = await readFile(f.path, 'utf8');
  assert(!updated.includes('return 301'));
  assert(updated.includes('rewrite ^ /max/callback/ last;'));
});
