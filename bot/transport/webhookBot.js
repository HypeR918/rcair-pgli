import { setTimeout as delay } from 'node:timers/promises';
import { Api, Bot, MaxError } from '@maxhub/max-bot-api';
import { assertWebhookApiPath, MAX_POLLING_DISABLED_MESSAGE } from './config.js';
import { createMaxClient } from './maxClient.js';

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
  bot.api.raw.messages.send = async ({ chat_id, user_id, disable_link_preview, ...body }) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bot.api.raw.post('messages', {
          body, query: { chat_id, user_id, disable_link_preview },
        });
      } catch (error) {
        if (!(error instanceof MaxError) || error.code !== 'attachment.not.ready' || attempt >= 2) throw error;
        await delay(1000);
      }
    }
  };

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
