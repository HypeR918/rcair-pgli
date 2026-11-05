import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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
      './config/env.js': { env: { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465',
        ...(configured ? { SMTP_USER: 'fixture', SMTP_PASS: 'synthetic' } : {}) } },
      nodemailer: { default: { createTransport: options => { transport = options; return {}; } } },
    });
    assert.equal(transport.secure, true);
    assert.deepEqual(transport.auth, configured ? { user: 'fixture', pass: 'synthetic' } : undefined);
  }
});

test('SMTP без приветствия завершает отправку по таймауту и закрывает сокет', async t => {
  const sockets = new Set();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', resolveClosed);
    // SMTP-сервер принял TCP, но намеренно не отправляет приветствие.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const email = await loadIsolated('services/emailService.js', { './config/env.js': { env: {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'offline@example.test',
    EMAIL_VERIFICATION_ENABLED: true, SMTP_TIMEOUT_MS: 60,
  } } });
  const sending = email.sendEmailVerificationCode('offline@example.test', '123456')
    .then(() => null, error => error);
  const result = await Promise.race([sending, delay(300).then(() => 'pending')]);
  assert.notEqual(result, 'pending', 'Ожидание SMTP блокирует диалог без короткого таймаута');
  assert.match(result.message, /Не удалось отправить код/);
  assert.notEqual(await Promise.race([closed, delay(200).then(() => 'pending')]), 'pending');
});
