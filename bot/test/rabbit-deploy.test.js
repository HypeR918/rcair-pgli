import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = new URL('../deploy/use-rabbitmq.sh', import.meta.url).pathname;
const image = `sha256:${'a'.repeat(64)}`;
async function run(t, failure = '', action = 'switch') {
  const dir = await mkdtemp(join(tmpdir(), 'rcair-rabbit-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  if (['rollback', 'update'].includes(action)) await writeFile(join(dir, '.rabbitmq-node-state'), `${image}\n`);
  if (action === 'update') {
    await writeFile(join(dir, 'rabbitmq.env'), 'RABBITMQ_DEFAULT_USER=offline\n');
    await writeFile(join(dir, '.rabbitmq-base.yml'), '{"services":{}}');
  }
  const shim = `#!${process.execPath} --
const fs=require('node:fs'), path=require('node:path');
const name=path.basename(process.argv[1]), args=process.argv.slice(2), failure=process.env.RCAIR_FAILURE;
if(name==='id'){console.log('0');process.exit(0)}
if(name==='sleep')process.exit(0);
if(name==='openssl'){console.log('${'b'.repeat(64)}');process.exit(0)}
fs.appendFileSync(process.env.RCAIR_COMMAND_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='inspect')console.log(args.includes('{{.Image}}')?'${image}':'max-glpi-bot:webhook');
if(args.includes('config')&&args.includes('--format'))console.log(JSON.stringify({services:{'max-bot':{image:'max-glpi-bot:webhook',environment:{BOT_TOKEN:'offline-token'}}}}));
if(failure==='build'&&args[0]==='build')process.exit(1);
if(failure==='worker'&&args.includes('up')&&args.at(-1)==='max-bot-worker')process.exit(1);
if(failure==='undrained'&&args.includes('assert-drained'))process.exit(2);
if(failure==='accepted-fail'&&args.includes('up')&&args.at(-1)==='max-bot'&&args.some(a=>a.endsWith('docker-compose.rabbitmq.yml')))process.exit(1);
if(failure==='accepted-fail'&&args.includes('assert-drained'))process.exit(2);
if(failure==='late-producer'&&args.includes('assert-drained')){
 const p=process.env.RCAIR_ASSERT_COUNT;const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));if(n>=1)process.exit(2);
}
`;
  for (const name of ['id','docker','openssl','sleep']) await writeFile(join(dir,'bin',name),shim,{mode:0o755});
  const log=join(dir,'commands.jsonl');
  const env={...process.env,PATH:`${join(dir,'bin')}:${process.env.PATH}`,MAX_BOT_DEPLOY_DIR:dir,
    RCAIR_FAILURE:failure,RCAIR_COMMAND_LOG:log,RCAIR_ASSERT_COUNT:join(dir,'assert-count')};
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync('bash',[script,action],{env,encoding:'utf8'});
  assert.ifError(result.error);
  const commands=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {...result,commands,dir};
}

test('Rabbit migration: offline build/init до остановки, затем один worker и ingress; DB/Nginx не останавливаются', async t=>{
  const r=await run(t);
  assert.equal(r.status,0,r.stderr);
  const position=p=>r.commands.findIndex(p);
  const stop=position(c=>c.includes('stop')&&c.at(-1)==='max-bot');
  assert(position(c=>c[0]==='build'&&c.includes('none'))<stop);
  assert(position(c=>c.includes('init'))<stop);
  assert(position(c=>c.includes('up')&&c.at(-1)==='max-bot-worker')>stop);
  const snapshot=r.commands.find(c=>c.includes('--no-interpolate'));
  assert(snapshot.includes('--no-env-resolution'));
  assert(!r.commands.some(c=>c.includes('down')));
  assert(!r.commands.some(c=>c.includes('stop')&&['nginx','max-bot-db'].includes(c.at(-1))));
  assert.equal((await readFile(join(r.dir,'.rabbitmq-node-state'),'utf8')).trim(),image);
  assert(!r.stdout.includes('b'.repeat(64)));
});

test('сбой offline build не останавливает текущего Node', async t=>{
  const r=await run(t,'build');
  assert.notEqual(r.status,0);
  assert(!r.commands.some(c=>c.includes('stop')));
  await assert.rejects(access(join(r.dir,'.rabbitmq-node-state')));
});

test('отказ worker до приёма событий возвращает прежний Node после проверки пустого inbox', async t=>{
  const r=await run(t,'worker');
  assert.notEqual(r.status,0);
  assert(r.commands.some(c=>c.includes('assert-drained')));
  const lastUp=r.commands.filter(c=>c.includes('up')).at(-1);
  assert(lastUp.includes('--no-deps')&&lastUp.at(-1)==='max-bot');
  assert(!lastUp.some(a=>a.endsWith('docker-compose.rabbitmq.yml')));
  await assert.rejects(access(join(r.dir,'.rabbitmq-node-state')));
});

test('откат с необработанными событиями запрещён; worker и данные сохраняются', async t=>{
  const r=await run(t,'undrained','rollback');
  assert.notEqual(r.status,0);
  assert(!r.commands.some(c=>c.includes('stop')&&c.at(-1)==='max-bot-worker'));
  assert(!r.commands.some(c=>c.includes('up')&&!c.some(a=>a.endsWith('docker-compose.rabbitmq.yml'))));
  await access(join(r.dir,'.rabbitmq-node-state'));
});

test('сбой ingress после приёма не приводит к небезопасному откату и потере очереди', async t=>{
  const r=await run(t,'accepted-fail');
  assert.notEqual(r.status,0);
  assert(!r.commands.some(c=>c.includes('stop')&&c.at(-1)==='max-bot-worker'));
  await access(join(r.dir,'.rabbitmq-node-state'));
});

test('событие между первой drain-проверкой и остановкой worker отменяет откат', async t=>{
  const r=await run(t,'late-producer','rollback');
  assert.notEqual(r.status,0);
  assert.equal(r.commands.filter(c=>c.includes('assert-drained')).length,2);
  assert(!r.commands.some(c=>c.includes('up')&&!c.some(a=>a.endsWith('docker-compose.rabbitmq.yml'))));
  const restored=r.commands.filter(c=>c.includes('up')).at(-1);
  assert(restored.includes('max-bot-worker')&&restored.includes('max-bot'));
  await access(join(r.dir,'.rabbitmq-node-state'));
});

test('update заменяет обе роли, сохраняет pending события и исходный образ для legacy rollback', async t=>{
  const r=await run(t,'','update');
  assert.equal(r.status,0,r.stderr);
  assert(r.commands.some(c=>c.includes('stop')&&c.includes('max-bot')&&c.includes('max-bot-worker')));
  assert(!r.commands.some(c=>c.includes('assert-drained')));
  const updates=r.commands.filter(c=>c.includes('up'));
  assert.deepEqual(updates.map(c=>c.at(-1)),['max-bot-worker','max-bot']);
  assert(updates.every(c=>c.some(a=>a.endsWith('docker-compose.rabbitmq.yml'))));
  await access(join(r.dir,'.rabbitmq-node-state'));
});

test('неудачный update возвращает старый queued-образ обеих ролей, не legacy Node', async t=>{
  const r=await run(t,'worker','update');
  assert.notEqual(r.status,0);
  const restored=r.commands.filter(c=>c.includes('up')).at(-1);
  assert(restored.includes('max-bot-worker')&&restored.includes('max-bot'));
  assert(restored.some(a=>a.endsWith('docker-compose.rabbitmq.yml')));
  assert(r.commands.some(c=>c[0]==='image'&&c[1]==='tag'&&c[2]===image&&c[3]==='max-glpi-bot:webhook'));
  await access(join(r.dir,'.rabbitmq-node-state'));
});
