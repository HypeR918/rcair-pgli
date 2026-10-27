import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isPublicAddress, validateAttachmentUrl, publicLookup } from '../utils/downloadPolicy.js';
import { loadIsolated } from './helpers/isolated.mjs';

test('политика URL запрещает HTTP, чужие домены, нестандартные порты и userinfo', () => {
  for (const url of ['http://files.max.ru/a', 'https://max.ru.evil.test/a', 'https://127.0.0.1/a',
    'https://files.max.ru:444/a', 'https://user:pass@files.max.ru/a']) {
    assert.throws(() => validateAttachmentUrl(url, ['.max.ru']));
  }
  assert.equal(validateAttachmentUrl('https://files.max.ru/a', ['.max.ru']).hostname, 'files.max.ru');
  assert.throws(() => validateAttachmentUrl('https://127.0.0.1/a', ['127.0.0.1']));
  assert.throws(() => validateAttachmentUrl('https://[::1]/a', ['[::1]']));
});

test('политика IP запрещает внутренние, mapped IPv6, служебные и documentation адреса', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.1.1', '192.168.1.1',
    '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('скачивание: токен только API; redirects проверяются; oversized и stream errors очищаются; работают квоты и TTL', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcair-download-tests-'));
  const old = process.env.TEMP_UPLOAD_DIR;
  process.env.TEMP_UPLOAD_DIR = dir;
  const requests = [];
  let response;
  try {
    const files = await loadIsolated('services/maxFileService.js', {
      './config/env.js': { env: { BOT_TOKEN: 'synthetic-test-token' } },
      axios: { default: { get: async (url, config) => { requests.push({ url, config }); return response(); } } },
    });
    const ctx = url => ({ message: { body: { attachments: [{ payload: { url, filename: 'fixture.bin' } }] } } });
    response = () => ({ status: 200, headers: {}, data: Readable.from(['fixture']) });
    const downloaded = await files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a'));
    assert.equal(requests[0].config.headers.Authorization, undefined);
    assert.equal(requests[0].config.proxy, false);
    assert.equal(requests[0].config.maxRedirects, 0);
    assert.equal(typeof requests[0].config.httpsAgent.options.lookup, 'function');
    await files.cleanupDownloadedFiles(downloaded);
    const apiFile = await files.collectDownloadedMaxAttachments(ctx('https://platform-api2.max.ru/a'));
    assert.equal(requests.at(-1).config.headers.Authorization, 'synthetic-test-token');
    await files.cleanupDownloadedFiles(apiFile);
    response = () => ({ status: 302, headers: { location: 'http://127.0.0.1/private' }, data: Readable.from([]) });
    await assert.rejects(files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a')));
    response = () => ({ status: 200, headers: {}, data: Readable.from([Buffer.alloc(20 * 1024 * 1024 + 1)]) });
    await assert.rejects(files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a')), /лимит/);
    assert.deepEqual(await readdir(dir), []);
    response = () => ({ status: 200, headers: {}, data: Readable.from((async function* () {
      yield 'partial'; throw new Error('broken stream');
    })()) });
    await assert.rejects(files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a')), /broken stream/);
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a'), Array(10).fill({ size: 1 })), /Не более/);
    await assert.rejects(files.collectDownloadedMaxAttachments(ctx('https://files.max.ru/a'), [{ size: 50 * 1024 * 1024 }]), /общий размер/);
    await writeFile(path.join(dir, 'max-upload-expired'), 'old');
    await writeFile(path.join(dir, 'unrelated-user-file'), 'keep');
    const ago = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path.join(dir, 'max-upload-expired'), ago, ago);
    await files.cleanupExpiredDownloads();
    assert.deepEqual(await readdir(dir), ['unrelated-user-file']);
  } finally {
    if (old === undefined) delete process.env.TEMP_UPLOAD_DIR; else process.env.TEMP_UPLOAD_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});


test('lookup отклоняет loopback при установлении соединения', async () => {
  await assert.rejects(new Promise((resolve, reject) => publicLookup('127.0.0.1', { all: true },
    (error, addresses) => error ? reject(error) : resolve(addresses))), /Запрещённый/);
  const addresses = await new Promise((resolve, reject) => publicLookup('8.8.8.8', { all: true },
    (error, result) => error ? reject(error) : resolve(result)));
  assert.equal(addresses[0].address, '8.8.8.8');
});
