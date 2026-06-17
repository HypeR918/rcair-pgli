import { Bot } from '@maxhub/max-bot-api';
import http from 'node:http';

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

const bot = new Bot(env.BOT_TOKEN);

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
      });

      res.end(
        JSON.stringify({
          ok: true,
          service: 'max-bot',
        })
      );

      return;
    }

    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });

    res.end('Not found');
  });

  server.listen(env.PORT, () => {
    console.log(`Healthcheck: http://localhost:${env.PORT}/health`);
  });

  return server;
}

async function startApp() {
  console.log('Запуск MAX-бота...');

  await ensureDatabaseSchema();
  await loadAllSessions();

  registerUserHandlers(bot);
  registerMessageHandler(bot);
  registerTicketActions(bot);

  bot.start();

  startSdsPolling(bot, env.GLPI_APPROVAL_POLL_MS);
  startTicketPolling(bot, env.GLPI_TICKET_POLL_MS);

  startHealthServer();

  console.log('Бот запущен.');
  console.log('Email verification enabled:', env.EMAIL_VERIFICATION_ENABLED);
  console.log('Registration polling interval:', env.GLPI_APPROVAL_POLL_MS, 'ms');
  console.log('Ticket polling interval:', env.GLPI_TICKET_POLL_MS, 'ms');
}

startApp().catch(error => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

async function shutdown() {
  console.log('Завершение работы...');

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
});

process.on('unhandledRejection', reason => {
  console.error('UnhandledRejection:', reason);
});