import process from 'node:process';
import { runForUser, serializeUserUpdates } from './utils/userUpdates.js';
import { startAttachmentCleanup } from './services/maxFileService.js';
import { MAX_API_URL } from './transport/config.js';
import { startMaxTransport } from './transport/maxTransport.js';
import { createWebhookBot } from './transport/webhookBot.js';
import { WebhookContext } from './transport/webhookContext.js';
import { createMaxApi } from './transport/maxApi.js';
import { readQueueConfig } from './queue/config.js';
import { createQueueResources } from './queue/resources.js';
import { connectRabbit } from './queue/rabbit.js';
import { startEventRelay } from './queue/relay.js';
import { startEventWorker } from './queue/worker.js';
import { startWorkerStatus } from './queue/statusServer.js';
import { handleApprovedSdsRequest, handleRejectedSdsRequest } from './controllers/sdsController.js';

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
const queueConfig = readQueueConfig();
const resources = createQueueResources(process.env, queueConfig);

const bot = createWebhookBot(env.BOT_TOKEN, {
  clientOptions: {
    baseUrl: MAX_API_URL,
  },
});

bot.use(serializeUserUpdates);

let transport;
let relay;
let worker;
let workerStatus;
let rabbit;
let releaseWorkerLock;
const timers = [];

async function startApp() {
  console.log(`Запуск MAX-бота: role=${queueConfig.role}`);
  await resources.store.ensureSchema();
  if (queueConfig.role === 'webhook') {
    transport = await startMaxTransport(bot, env, {
      acceptUpdate: resources.store.accept, queueSnapshot: () => ({ mode: 'inbox', publisher: 'worker' }),
      existingSubscription: true,
    });
  } else {
    // Единственный владелец кэша сессий и фоновых задач — worker.
    releaseWorkerLock = await resources.acquireWorkerLock(() => shutdown(1));
    rabbit = await connectRabbit(queueConfig, { onClose: () => shutdown(1) });
    await ensureDatabaseSchema();
    await loadAllSessions();
    registerUserHandlers(bot);
    registerMessageHandler(bot);
    registerTicketActions(bot);
    bot.botInfo = await createMaxApi(env.BOT_TOKEN)('GET', '/me');
    if (!bot.botInfo?.user_id) throw new Error('MAX не подтвердил учётную запись worker');
    worker = await startEventWorker(resources.store, rabbit, async update => {
      if (update.update_type === 'sds_approved' || update.update_type === 'sds_rejected') {
        return runForUser(update.user.user_id, () => update.update_type === 'sds_approved'
          ? handleApprovedSdsRequest(bot, update.request) : handleRejectedSdsRequest(bot, update.request));
      }
      // Дедупликация уже долговечная в SQL; memory-cache подавил бы ручной retry.
      return bot.middleware()(new WebhookContext(update, bot.api, bot.botInfo), () => Promise.resolve());
    });
    relay = startEventRelay(resources.store, queueConfig);
    workerStatus = await startWorkerStatus(env.PORT, () => ({ ...worker.snapshot(), relay: relay.snapshot() }));
    timers.push(await startAttachmentCleanup());
    timers.push(startSdsPolling(bot, env.GLPI_APPROVAL_POLL_MS, { enqueueDecision: resources.store.accept }));
    timers.push(startTicketPolling(bot, env.GLPI_TICKET_POLL_MS));
  }
  console.log(`MAX-бот запущен: role=${queueConfig.role}`);
}

startApp().catch(error => {
  const code = /^[A-Z0-9_.-]{1,64}$/.test(error.code || '') ? error.code
    : Number.isInteger(error.status) ? `HTTP_${error.status}` : 'STARTUP_FAILED';
  console.error(`Не удалось запустить роль MAX-бота: ${code}. Проверьте БД/RabbitMQ/MAX и настройки.`);
  shutdown(1);
});

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Завершение работы...');
  const deadline = setTimeout(() => process.exit(exitCode), queueConfig.role === 'worker' ? 180000 : 20000);
  deadline.unref();
  for (const timer of timers) clearInterval(timer);
  for (const stop of [() => transport?.stop(), () => workerStatus?.stop(), () => worker?.stop(),
    () => rabbit?.close(), () => relay?.stop(), () => releaseWorkerLock?.()]) {
    try { await stop(); } catch { console.error('Ошибка остановки компонента очереди'); }
  }

  try {
    if (queueConfig.role === 'worker') {
      const { killCurrentSession } = await import('./services/glpiService.js');
      await killCurrentSession();
    }
  } catch (error) {
    console.error('Session cleanup error:', error.message);
  }

  try {
    await closeDb();
    await resources.pool.end();
  } catch (error) {
    console.error('closeDb error:', error.message);
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

process.on('uncaughtException', () => { console.error('Необработанная ошибка процесса MAX'); shutdown(1); });
process.on('unhandledRejection', () => { console.error('Необработанный Promise процесса MAX'); shutdown(1); });
