import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createWebhookBot } from '../transport/webhookBot.js';
import { WebhookContext } from '../transport/webhookContext.js';
import { createEventCodec } from '../queue/eventCodec.js';
import { serializeUserUpdates } from '../utils/userUpdates.js';
import { State } from '../utils/constants.js';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import * as db from '../services/dbService.js';
import * as glpi from '../services/glpiService.js';

const stub = module => Object.fromEntries(Object.keys(module).map(name => [name, noop]));
const image = { type: 'image', payload: { photo_id: 42, url: 'https://fd.oneme.ru/photo', token: 'photo-token' } };
const archive = { type: 'file', filename: 'logs.zip', size: 7,
  payload: { url: 'https://fd.oneme.ru/archive', token: 'file-token' } };

async function fixture(t, { allowedHosts } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcair-webhook-files-'));
  const old = process.env.TEMP_UPLOAD_DIR;
  const oldAllowedHosts = process.env.MAX_ATTACHMENT_ALLOWED_HOSTS;
  process.env.TEMP_UPLOAD_DIR = dir;
  if (allowedHosts === undefined) delete process.env.MAX_ATTACHMENT_ALLOWED_HOSTS;
  else process.env.MAX_ATTACHMENT_ALLOWED_HOSTS = allowedHosts;
  t.after(async () => {
    if (old === undefined) delete process.env.TEMP_UPLOAD_DIR; else process.env.TEMP_UPLOAD_DIR = old;
    if (oldAllowedHosts === undefined) delete process.env.MAX_ATTACHMENT_ALLOWED_HOSTS;
    else process.env.MAX_ATTACHMENT_ALLOWED_HOSTS = oldAllowedHosts;
    await rm(dir, { recursive: true, force: true });
  });
  const requests = [];
  let downloadError;
  const files = await loadIsolated('services/maxFileService.js', {
    './config/env.js': { env: { BOT_TOKEN: 'offline-token' } },
    axios: { default: { get: async (url, config) => {
      requests.push({ url, config });
      if (downloadError) throw downloadError;
      return { status: 200, headers: {}, data: Readable.from(['fixture']) };
    } } },
  });
  const replies = [];
  const uploaded = [];
  let failSave = false;
  let session = { state: State.WAIT_NEW_TICKET_FILES, ticketDraft: {
    title: 'Тестовая заявка', description: 'Описание проблемы', files: [],
  } };
  const mocks = {
    './state/sessionStore.js': {
      getSession: () => structuredClone(session),
      setSession: async (_id, value) => {
        if (failSave) throw new Error('fixture DB unavailable');
        session = structuredClone(value);
      },
      deleteSession: noop,
    },
    './services/dbService.js': { ...stub(db), findGlpiUserByMaxId: async () => ({ id: 42 }) },
    './services/glpiService.js': { ...stub(glpi),
      createGlpiUserTicket: async () => ({ ticketId: 7, title: session.ticketDraft.title }),
      uploadAndAttachFilesToTicket: async (_ticketId, attachments) => {
        for (const file of attachments) uploaded.push({ ...file, bytes: await readFile(file.path, 'utf8') });
        return attachments;
      },
    },
    './services/maxFileService.js': files,
  };
  const messages = await loadIsolated('controllers/messageController.js', mocks);
  const tickets = await loadIsolated('controllers/ticketController.js', mocks);
  const bot = createWebhookBot('offline-token');
  bot.api.sendMessageToChat = async (_chatId, text) => { replies.push(text); };
  bot.use(serializeUserUpdates);
  messages.registerMessageHandler(bot);
  tickets.registerTicketActions(bot);
  const codec = createEventCodec('offline-event-secret-32-characters-long');
  let sequence = 0;
  // Worker восстанавливает тот же payload, который ingress записал в inbox.
  const deliver = async update => {
    const { eventKey } = codec.identify(update);
    const restored = codec.decode(codec.encode(update, eventKey), eventKey);
    await bot.middleware()(new WebhookContext(restored, bot.api, { user_id: 999 }), noop);
  };
  const message = attachments => deliver({ update_type: 'message_created', timestamp: ++sequence,
    message: { sender: { user_id: 123 }, recipient: { chat_id: 456, chat_type: 'dialog' },
      body: { mid: `file.${sequence}`, text: null, attachments } } });
  const action = payload => deliver({ update_type: 'message_callback', timestamp: ++sequence,
    message: { recipient: { chat_id: 456, chat_type: 'dialog' }, body: { mid: 'keyboard' } },
    callback: { callback_id: `callback.${sequence}`, user: { user_id: 123 }, payload } });
  return { dir, message, action, replies, uploaded, requests, getSession: () => structuredClone(session),
    failDownload: value => { downloadError = value; }, failSave: value => { failSave = value; } };
}

test('webhook/inbox: изображение и архив доходят до подтверждения и загрузки в GLPI', async t => {
  const f = await fixture(t);
  await f.message([image]);
  await f.message([archive]);
  assert.equal(f.getSession().ticketDraft.files.length, 2);
  assert.equal(f.getSession().ticketDraft.files[1].filename, 'logs.zip');
  assert(f.requests.every(request => request.config.headers.Authorization === undefined));
  await f.action('ticket:create_with_files');
  assert.equal(f.getSession().state, State.WAIT_TICKET_CONFIRM);
  await f.action('ticket:confirm_create');
  assert.equal(f.uploaded.length, 2);
  assert(f.uploaded.every(file => file.bytes === 'fixture'));
  assert.equal(f.getSession().state, State.IDLE);
  assert.deepEqual(await readdir(f.dir), []);
});

test('ошибка скачивания не теряет черновик и предыдущие файлы; повтор и подтверждение работают', async t => {
  const f = await fixture(t);
  await f.message([image]);
  const before = f.getSession();
  f.failDownload(new Error('fixture download timeout'));
  await f.message([archive]);
  assert.deepEqual(f.getSession(), before);
  assert.equal(await readFile(before.ticketDraft.files[0].path, 'utf8'), 'fixture');
  assert.match(f.replies.at(-1), /Черновик и ранее добавленные файлы сохранены/);
  f.failDownload(null);
  await f.message([archive]);
  await f.action('ticket:create_with_files');
  await f.action('ticket:confirm_create');
  assert.equal(f.uploaded.length, 2);
});

test('похожие домены хранилища отклоняются до HTTP и не удаляют уже добавленные файлы', async t => {
  const f = await fixture(t);
  await f.message([image]);
  const before = f.getSession();
  for (const hostname of ['fd.oneme.ru.evil.test', 'evil-fd.oneme.ru', 'untrusted.oneme.ru']) {
    await f.message([{ ...archive, payload: { url: `https://${hostname}/archive` } }]);
    assert.deepEqual(f.getSession(), before);
    assert.equal(await readFile(before.ticketDraft.files[0].path, 'utf8'), 'fixture');
  }
  assert.equal(f.requests.length, 1);
});

test('явный MAX_ATTACHMENT_ALLOWED_HOSTS сохраняет ограничения администратора', async t => {
  const f = await fixture(t, { allowedHosts: '.max.ru' });
  await f.message([image]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.getSession().state, State.WAIT_NEW_TICKET_FILES);
  assert.deepEqual(f.getSession().ticketDraft.files, []);
});

test('сбой сохранения нового файла удаляет только новый файл и сохраняет прежний черновик', async t => {
  const f = await fixture(t);
  await f.message([image]);
  const before = f.getSession();
  f.failSave(true);
  await f.message([archive]);
  assert.deepEqual(f.getSession(), before);
  assert.equal(await readFile(before.ticketDraft.files[0].path, 'utf8'), 'fixture');
  assert.deepEqual(await readdir(f.dir), [path.basename(before.ticketDraft.files[0].path)]);
});
