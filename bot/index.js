import process from 'node:process';
import { serializeUserUpdates } from './utils/userUpdates.js';
import { startAttachmentCleanup } from './services/maxFileService.js';
import { MAX_API_URL } from './transport/config.js';
import { startMaxTransport } from './transport/maxTransport.js';
import { createWebhookBot } from './transport/webhookBot.js';

import { env, requireEnv } from './config/env.js';

import {
  ensureDatabaseSchema,
  closeDb,
} from './services/dbService.js';

import {
  loadAllSessions,
} from './state/sessionStore.js';

import {
  registerUserHandlers,
} from './controllers/userController.js';

import {
  registerMessageHandler,
} from './controllers/messageController.js';

import {
  registerTicketActions,
} from './controllers/ticketController.js';

import {
  startSdsPolling,
} from './polling/sdsPolling.js';

import {
  startTicketPolling,
} from './polling/ticketPolling.js';

requireEnv();

const bot = createWebhookBot(env.BOT_TOKEN, {
  clientOptions: {
    baseUrl: MAX_API_URL,
  },
});

bot.use(serializeUserUpdates);

let transport;
const timers = [];

async function startApp() {
  console.log('Запуск MAX-бота...');

  await ensureDatabaseSchema();
  await loadAllSessions();
  timers.push(await startAttachmentCleanup());

  registerUserHandlers(bot);
  registerMessageHandler(bot);
  registerTicketActions(bot);

  transport = await startMaxTransport(bot, env);
  timers.push(startSdsPolling(bot, env.GLPI_APPROVAL_POLL_MS));
  timers.push(startTicketPolling(bot, env.GLPI_TICKET_POLL_MS));

  console.log('Бот запущен.');
  console.log('Email verification enabled:', env.EMAIL_VERIFICATION_ENABLED);
  console.log('GLPI: интервал проверки регистрационных заявок:', env.GLPI_APPROVAL_POLL_MS, 'ms');
  console.log('GLPI: интервал проверки заявок поддержки:', env.GLPI_TICKET_POLL_MS, 'ms');
}

startApp().catch(error => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Завершение работы...');
  for (const timer of timers) clearInterval(timer);
  await transport?.stop();

  try {
    const { killCurrentSession } = await import('./services/glpiService.js');
    await killCurrentSession();
  } catch (error) {
    console.error('Session cleanup error:', error.message);
  }

  try {
    await closeDb();
  } catch (error) {
    console.error('closeDb error:', error.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', error => {
  console.error('UncaughtException:', error);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  console.error('UnhandledRejection:', reason);
  process.exit(1);
});
