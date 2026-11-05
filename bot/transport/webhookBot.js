import { setTimeout as delay } from 'node:timers/promises';
import { Api, Bot, MaxError } from '@maxhub/max-bot-api';
import { assertWebhookApiPath, MAX_POLLING_DISABLED_MESSAGE } from './config.js';
import { createMaxClient } from './maxClient.js';
import { recordMaxReply, withOperation } from '../utils/operationContext.js';

async function pollingDisabled() {
  throw new Error(MAX_POLLING_DISABLED_MESSAGE);
}

export function createWebhookBot(token, options = {}) {
  const bot = new Bot(token, options);
  // SDK 0.2.5 не поддерживает timeout в clientOptions и использует fetch без signal.
  // Публичный Api(client) позволяет отменять зависший HTTP без замены global fetch.
  bot.api = new Api(createMaxClient(token, options.clientOptions));

  // SDK 0.2.5 бесконечно повторяет attachment.not.ready. Сохраняем ожидание
  // готовности вложения, но ограничиваем его двумя повторами после первой попытки.
  bot.api.raw.messages.send = params => withOperation('max.send', async () => {
    const { chat_id, user_id, disable_link_preview, ...body } = params;
    recordMaxReply('attempted');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await bot.api.raw.post('messages', {
            body, query: { chat_id, user_id, disable_link_preview },
          });
          // SDK 0.2.5 считает любой HTTP 200 успехом, даже без message.
          // Для подтверждённой отправки MAX должен вернуть Message с mid.
          if (typeof result?.message?.body?.mid !== 'string' || !result.message.body.mid) {
            const error = new Error('MAX API не подтвердил отправку сообщения');
            error.code = 'MAX_API_UNCONFIRMED';
            throw error;
          }
          recordMaxReply('confirmed');
          return result;
        } catch (error) {
          if (!(error instanceof MaxError) || error.code !== 'attachment.not.ready' || attempt >= 2) throw error;
          await delay(1000);
        }
      }
    } catch (error) {
      recordMaxReply('failed');
      throw error;
    }
  });

  // Эти публичные методы SDK запускают или обслуживают long polling MAX.
  // Запрет нельзя случайно снять присваиванием нового обработчика.
  for (const [target, method] of [
    [bot, 'start'],
    [bot.api, 'getUpdates'],
    [bot.api.raw.subscriptions, 'getUpdates'],
  ]) {
    Object.defineProperty(target, method, { value: pollingDisabled, writable: false, configurable: false });
  }

  const rawGet = bot.api.raw.get.bind(bot.api.raw);
  Object.defineProperty(bot.api.raw, 'get', {
    value: async (path, options) => {
      assertWebhookApiPath(path);
      return rawGet(path, options);
    },
    writable: false,
    configurable: false,
  });
  return bot;
}
