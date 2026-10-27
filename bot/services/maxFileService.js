import axios from 'axios';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicLookup, validateAttachmentUrl } from '../utils/downloadPolicy.js';
import { env } from '../config/env.js';

const TEMP_UPLOAD_DIR = process.env.TEMP_UPLOAD_DIR || path.join(process.cwd(), 'tmp', 'uploads');
function limit(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Некорректный лимит ${name}`);
  return value;
}
const MAX_ATTACHMENT_BYTES = limit('MAX_ATTACHMENT_BYTES', 20 * 1024 * 1024);
const MAX_DRAFT_FILES = limit('MAX_DRAFT_FILES', 10);
const MAX_DRAFT_BYTES = limit('MAX_DRAFT_BYTES', 50 * 1024 * 1024);
const UPLOAD_TTL_MS = limit('UPLOAD_TTL_MS', 24 * 60 * 60 * 1000);
const allowedHosts = (process.env.MAX_ATTACHMENT_ALLOWED_HOSTS || '.max.ru')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
const tokenHosts = new Set(['platform-api2.max.ru', 'platform-api.max.ru', 'api.max.ru']);
const downloadAgent = new https.Agent({ lookup: publicLookup });

function safeFilename(name, fallbackExt = '') {
  const raw = String(name || '').trim() || `attachment-${Date.now()}${fallbackExt}`;
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function getMessageAttachments(ctx) {
  return (
    ctx.message?.body?.attachments ||
    ctx.message?.attachments ||
    ctx.message?.body?.message?.attachments ||
    []
  );
}

function extractPayload(attachment) {
  return attachment?.payload || attachment?.data || attachment || {};
}

function findUrlDeep(value, depth = 0) {
  if (!value || depth > 5) return null;

  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlDeep(item, depth + 1);
      if (found) return found;
    }

    return null;
  }

  if (typeof value === 'object') {
    const preferredKeys = [
      'download_url',
      'downloadUrl',
      'file_url',
      'fileUrl',
      'media_url',
      'mediaUrl',
      'url',
      'src',
      'link',
    ];

    for (const key of preferredKeys) {
      const found = findUrlDeep(value[key], depth + 1);
      if (found) return found;
    }

    for (const item of Object.values(value)) {
      const found = findUrlDeep(item, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function guessFilename(attachment, index) {
  const payload = extractPayload(attachment);

  const name =
    payload.filename ||
    payload.file_name ||
    payload.name ||
    payload.title ||
    attachment.filename ||
    attachment.file_name ||
    attachment.name ||
    `attachment-${index + 1}`;

  return safeFilename(name);
}

function guessMimeType(attachment) {
  const payload = extractPayload(attachment);

  return (
    payload.mime_type ||
    payload.mimeType ||
    payload.content_type ||
    payload.contentType ||
    attachment.mime_type ||
    attachment.mimeType ||
    'application/octet-stream'
  );
}

async function ensureTempDir() {
  await fsp.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
}

async function downloadFile(sourceUrl, filename, mimeType, maxBytes) {
  await ensureTempDir();
  const localPath = path.join(TEMP_UPLOAD_DIR, `max-upload-${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${filename}`);
  let response;
  try {
    let url = validateAttachmentUrl(sourceUrl, allowedHosts);
    for (let redirect = 0; ; redirect++) {
      response = await axios.get(url.href, {
        responseType: 'stream',
        timeout: 120000,
        signal: AbortSignal.timeout(120000),
        maxRedirects: 0,
        // Прямое соединение необходимо для привязки проверенного DNS-адреса к сокету.
        proxy: false,
        httpsAgent: downloadAgent,
        headers: tokenHosts.has(url.hostname) ? { Authorization: env.BOT_TOKEN } : {},
        validateStatus: () => true,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.data.destroy();
        if (redirect >= 3 || !response.headers.location) throw new Error('Слишком много перенаправлений вложения');
        url = validateAttachmentUrl(new URL(response.headers.location, url).href, allowedHosts);
        continue;
      }
      break;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Ошибка скачивания вложения: ${response.status}`);
    if (Number(response.headers['content-length'] || 0) > maxBytes) throw new Error('Файл превышает лимит размера');
    let downloaded = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        downloaded += chunk.length;
        callback(downloaded > maxBytes ? new Error('Файл превышает лимит размера') : null,
          downloaded > maxBytes ? undefined : chunk);
      },
    });
    await pipeline(response.data, limiter, fs.createWriteStream(localPath, { flags: 'wx', mode: 0o600 }));
    return { path: localPath, filename, mimeType, size: downloaded };
  } catch (error) {
    response?.data?.destroy();
    await fsp.unlink(localPath).catch(() => {});
    throw error;
  }
}

export async function collectDownloadedMaxAttachments(ctx, existingFiles = []) {
  const attachments = getMessageAttachments(ctx);

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  if (existingFiles.length + attachments.length > MAX_DRAFT_FILES) {
    throw new Error(`Не более ${MAX_DRAFT_FILES} вложений в заявке`);
  }
  const files = [];
  let totalBytes = existingFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const payload = extractPayload(attachment);
    const url = findUrlDeep(payload) || findUrlDeep(attachment);

    if (!url) {
      await cleanupDownloadedFiles(files);
      throw new Error('Не удалось определить ссылку на вложение');
    }

    const filename = guessFilename(attachment, index);
    const mimeType = guessMimeType(attachment);

    try {
      const remaining = Math.min(MAX_ATTACHMENT_BYTES, MAX_DRAFT_BYTES - totalBytes);
      if (remaining <= 0) throw new Error('Превышен общий размер вложений заявки');
      const file = await downloadFile(url, filename, mimeType, remaining);
      files.push(file);
      totalBytes += file.size;
    } catch (error) {
      await cleanupDownloadedFiles(files);
      throw error;
    }
  }

  return files;
}

export async function cleanupDownloadedFiles(files) {
  for (const file of files || []) {
    try {
      if (file?.path) {
        await fsp.unlink(file.path);
      }
    } catch {
    }
  }
}

export async function cleanupExpiredDownloads() {
  await ensureTempDir();
  for (const name of await fsp.readdir(TEMP_UPLOAD_DIR)) {
    if (!name.startsWith('max-upload-')) continue;
    const file = path.join(TEMP_UPLOAD_DIR, name);
    try {
      const info = await fsp.lstat(file);
      if (info.isFile() && Date.now() - info.mtimeMs > UPLOAD_TTL_MS) await fsp.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Очистка вложений:', error.message);
    }
  }
}

export async function startAttachmentCleanup() {
  await cleanupExpiredDownloads();
  const timer = setInterval(() => {
    cleanupExpiredDownloads().catch(error => console.error('Очистка вложений:', error.message));
  }, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
