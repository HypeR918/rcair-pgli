// Изолированный бот для проверки настоящего Nginx; внешних MAX/GLPI/SQL нет.
import http from 'node:http';
import { once } from 'node:events';
import { createWebhookBot } from '../../transport/webhookBot.js';
import { startMaxTransport } from '../../transport/maxTransport.js';
import { createMaxApi } from '../../transport/maxApi.js';

const config = {
  BOT_TOKEN: 'offline-token', PORT: 3000, BOT_TRANSPORT: 'webhook',
  WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/',
  WEBHOOK_SECRET: 'offline-webhook-secret',
};
// Исходящие сообщения идут настоящим SDK через общий HTTP-клиент в локальную заглушку.
const maxApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const path = new URL(req.url, 'http://fixture').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (path === '/me') return res.end('{"user_id":999,"username":"offline_bot"}');
  if (path === '/subscriptions') return res.end(req.method === 'GET' ? '{"subscriptions":[]}' : '{"success":true}');
  if (path === '/messages') {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.text === 'Зависший запрос') return;
    console.log(body.text === 'Тест кнопки' ? 'DOCKER_SMOKE_CALLBACK' : 'DOCKER_SMOKE_REPLY');
    return res.end(JSON.stringify({ message: { body: { mid: 'reply.mid', text: body.text } } }));
  }
  res.writeHead(500); res.end('{"message":"unexpected API request"}');
});
maxApi.listen(3001, '127.0.0.1'); await once(maxApi, 'listening');
const apiUrl = 'http://127.0.0.1:3001';
const bot = createWebhookBot(config.BOT_TOKEN, { clientOptions: { baseUrl: apiUrl, timeout: 500 } });
bot.command('start', ctx => ctx.reply('Тестовое меню'));
bot.action('menu:help', ctx => ctx.reply('Тест кнопки'));
bot.command('stall', ctx => ctx.reply('Зависший запрос'));
bot.command('fail', () => { throw new Error('Искусственная ошибка обработки'); });
const transport = await startMaxTransport(bot, config, { api: createMaxApi(config.BOT_TOKEN, apiUrl) });
process.on('SIGTERM', async () => {
  await transport.stop();
  maxApi.closeAllConnections();
  await new Promise(resolve => maxApi.close(resolve));
  process.exit(0);
});
