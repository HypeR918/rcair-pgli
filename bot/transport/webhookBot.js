import { Bot } from '@maxhub/max-bot-api';
import { assertWebhookApiPath, MAX_POLLING_DISABLED_MESSAGE } from './config.js';

async function pollingDisabled() {
  throw new Error(MAX_POLLING_DISABLED_MESSAGE);
}

export function createWebhookBot(token, options = {}) {
  const bot = new Bot(token, options);

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
