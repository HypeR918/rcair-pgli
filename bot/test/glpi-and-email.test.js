import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadIsolated } from './helpers/isolated.mjs';

test('зависший GLPI-запрос завершается по таймауту', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/initSession') { res.setHeader('Content-Type', 'application/json'); res.end('{"session_token":"synthetic"}'); }
    // Запрос Ticket намеренно не получает ответ.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const glpi = await loadIsolated('services/glpiService.js', {
      './config/env.js': { env: { GLPI_API_URL: `http://127.0.0.1:${server.address().port}`, GLPI_API_USER_TOKEN: 'synthetic', GLPI_API_TIMEOUT_MS: 100 } },
    });
    await assert.rejects(glpi.getGlpiTicket(7), error => ['ECONNABORTED', 'ERR_CANCELED'].includes(error.code));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('SMTP передаёт настроенную авторизацию, сохраняя работу relay без логина', async () => {
  for (const configured of [false, true]) {
    let transport;
    await loadIsolated('services/emailService.js', {
      './config/env.js': { env: { SMTP_HOST: 'smtp.example.test', SMTP_PORT: 465,
        ...(configured ? { SMTP_USER: 'fixture', SMTP_PASS: 'synthetic' } : {}) } },
      nodemailer: { default: { createTransport: options => { transport = options; return {}; } } },
    });
    assert.equal(transport.secure, true);
    assert.deepEqual(transport.auth, configured ? { user: 'fixture', pass: 'synthetic' } : undefined);
  }
});
