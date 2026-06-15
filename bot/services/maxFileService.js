import axios from 'axios';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const TEMP_UPLOAD_DIR = process.env.TEMP_UPLOAD_DIR || path.join(process.cwd(), 'tmp', 'uploads');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 20 * 1024 * 1024);

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

async function downloadFile(url, filename, mimeType) {
  await ensureTempDir();

  const random = crypto.randomBytes(8).toString('hex');
  const localPath = path.join(TEMP_UPLOAD_DIR, `${Date.now()}-${random}-${filename}`);

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers: {
      Authorization: env.BOT_TOKEN,
    },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MAX attachment download failed: ${response.status}`);
  }

  const contentLength = Number(response.headers['content-length'] || 0);

  if (contentLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Файл слишком большой: ${contentLength} bytes`);
  }

  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(localPath);

    response.data.on('data', chunk => {
      downloaded += chunk.length;

      if (downloaded > MAX_ATTACHMENT_BYTES) {
        response.data.destroy(new Error(`Файл больше лимита ${MAX_ATTACHMENT_BYTES} bytes`));
      }
    });

    response.data.pipe(writer);

    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return {
    path: localPath,
    filename,
    mimeType,
    size: downloaded,
    sourceUrl: url,
  };
}

export async function collectDownloadedMaxAttachments(ctx) {
  const attachments = getMessageAttachments(ctx);

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const files = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const payload = extractPayload(attachment);
    const url = findUrlDeep(payload) || findUrlDeep(attachment);

    if (!url) {
      console.warn('MAX attachment has no downloadable URL. Type:', attachment.type, 'Payload keys:', Object.keys(payload || {}));
      console.warn('Raw attachment:', JSON.stringify(attachment, null, 2));
      continue;
    }

    const filename = guessFilename(attachment, index);
    const mimeType = guessMimeType(attachment);

    try {
      const file = await downloadFile(url, filename, mimeType);
      files.push(file);
    } catch (error) {
      console.error('MAX attachment download error:', error.message, 'URL:', url);
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