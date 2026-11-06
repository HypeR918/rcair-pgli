// Только изолированный Docker smoke: локальная HTTPS платформа MAX.
import https from 'node:https';
import { readFileSync } from 'node:fs';

let messages = 0;
let subscriptions = 0;
let updates = 0;
let mode = 'normal';
https.createServer({ key: readFileSync('/fixtures/privkey.pem'), cert: readFileSync('/fixtures/fullchain.pem') }, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const path = new URL(req.url, 'https://fixture').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (path === '/mode') { mode = JSON.parse(Buffer.concat(chunks)).mode; return res.end('{"ok":true}'); }
  if (path === '/stats') return res.end(JSON.stringify({ messages, subscriptions, updates }));
  if (path === '/me') return res.end('{"user_id":999,"first_name":"Тест","is_bot":true,"username":"offline_bot"}');
  if (path === '/subscriptions') {
    if (req.method === 'POST') { subscriptions++; return res.end('{"success":true}'); }
    return res.end('{"subscriptions":[{"url":"https://botsupport.gov70.ru/max/callback/","update_types":["message_created","message_callback","bot_started"]}]}');
  }
  if (path === '/updates') { updates++; res.writeHead(500); return res.end('{}'); }
  if (path === '/messages') {
    messages++;
    if (mode === 'hold') return;
    return res.end(JSON.stringify({ message: { body: { mid: `reply.${messages}`, text: 'Тестовый ответ' } } }));
  }
  res.writeHead(404); res.end('{}');
}).listen(443, '0.0.0.0');
