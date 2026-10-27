import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isValidEmail } from './utils/validation.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import 'dotenv/config';

const execFileAsync = promisify(execFile);

const HOST = process.env.IMPORTER_HOST || '127.0.0.1';
const PORT = Number(process.env.IMPORTER_PORT || 3100);
const SECRET = process.env.GLPI_IMPORT_SECRET || '';
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const GLPI_CONTAINER = process.env.GLPI_DOCKER_CONTAINER || 'glpi';
const GLPI_CONTAINER_USER = process.env.GLPI_CONTAINER_USER || '';
const GLPI_CONSOLE_PATH = process.env.GLPI_CONSOLE_PATH || '/var/www/html/bin/console';
const GLPI_LDAP_FILTER_ATTRIBUTE = process.env.GLPI_LDAP_FILTER_ATTRIBUTE || 'mail';
const COMMAND_TIMEOUT_MS = Number(process.env.GLPI_IMPORT_COMMAND_TIMEOUT_MS || 120000);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16 * 1024) {
        req.destroy();
        reject(new Error('request_body_too_large'));
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });

    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request_aborted')));
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeLdapFilterValue(value) {
  return String(value).replace(/[\0()*\\]/g, char => {
    return '\\' + char.charCodeAt(0).toString(16).padStart(2, '0');
  });
}

function buildDockerArgs(email) {
  const filter = `(${GLPI_LDAP_FILTER_ATTRIBUTE}=${escapeLdapFilterValue(email)})`;
  const args = ['exec'];

  if (GLPI_CONTAINER_USER) {
    args.push('-u', GLPI_CONTAINER_USER);
  }

  args.push(
    GLPI_CONTAINER,
    'php',
    GLPI_CONSOLE_PATH,
    'glpi:ldap:synchronize_users',
    '-c',
    '-f',
    filter,
    '-n'
  );

  return { args, filter };
}

async function runGlpiImport(email) {
  const { args, filter } = buildDockerArgs(email);
  console.log('[GLPI Importer] Running LDAP import with filter:', filter);

  const { stdout, stderr } = await execFileAsync(DOCKER_BIN, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });

  return { stdout, stderr, filter };
}

export function createImporterServer({ secret = SECRET, runImport = runGlpiImport, maxConcurrent = 1 } = {}) {
  if (!secret.trim()) throw new Error('GLPI_IMPORT_SECRET обязателен для запуска importer');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Некорректный лимит импортов');
  const expected = Buffer.from(`Bearer ${secret}`);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/internal/import-ldap-user') {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    if (active >= maxConcurrent) {
      res.setHeader('Retry-After', '5');
      sendJson(res, 429, { ok: false, error: 'import_busy' });
      return;
    }
    active++;
    try {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body?.email);
      if (!isValidEmail(email)) {
        sendJson(res, 400, { ok: false, error: 'bad_email' });
        return;
      }
      await runImport(email);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('[GLPI Importer] Import failed:', error.code || error.name);
      if (!res.destroyed) {
        const badRequest = ['invalid_json', 'request_body_too_large'].includes(error.message);
        sendJson(res, badRequest ? 400 : 500, { ok: false, error: badRequest ? error.message : 'import_failed' });
      }
    } finally {
      active--;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createImporterServer().listen(PORT, HOST, () => {
    console.log(`[GLPI Importer] Listening on http://${HOST}:${PORT}`);
  });
}
