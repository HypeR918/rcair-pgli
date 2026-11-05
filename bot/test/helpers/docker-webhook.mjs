// Изолированный бот для проверки настоящего Nginx; внешних MAX/GLPI/SQL нет.
import { createWebhookBot } from '../../transport/webhookBot.js';
import { startMaxTransport } from '../../transport/maxTransport.js';

const config = {
  BOT_TOKEN: 'offline-token', PORT: 3000, BOT_TRANSPORT: 'webhook',
  WEBHOOK_URL: 'https://botsupport.gov70.ru/max/callback/',
  WEBHOOK_SECRET: 'offline-webhook-secret',
};
const bot = createWebhookBot(config.BOT_TOKEN);
bot.api.sendMessageToChat = async () => { console.log('DOCKER_SMOKE_REPLY'); };
bot.command('start', ctx => ctx.reply('Тестовое меню'));
bot.command('fail', () => { throw new Error('Искусственная ошибка обработки'); });
const api = async (method, path) => {
  if (path === '/me') return { user_id: 999, username: 'offline_bot' };
  if (method === 'GET' && path === '/subscriptions') return { subscriptions: [] };
  if (method === 'POST' && path === '/subscriptions') return { success: true };
  throw new Error('Неожиданный запрос к заглушке MAX');
};
const transport = await startMaxTransport(bot, config, { api });
process.on('SIGTERM', async () => { await transport.stop(); process.exit(0); });
