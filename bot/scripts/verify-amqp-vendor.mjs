import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = new URL('../vendor/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('amqp-runtime.json', base)));
const digest = createHash('sha256').update(readFileSync(new URL('amqp-runtime.tgz', base))).digest('hex');
if (digest !== manifest.archive_sha256) throw new Error('Контрольная сумма AMQP runtime не совпала');
if (process.argv.includes('--installed')) {
  for (const [name, expected] of Object.entries(manifest.packages)) {
    const pkg = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url)));
    if (pkg.version !== expected.version) throw new Error(`Не совпала версия ${name}`);
  }
}
console.log('AMQP runtime: контрольная сумма проверена.');
