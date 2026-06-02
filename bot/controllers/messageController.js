import { State } from '../utils/constants.js';
import { getSession } from '../state/sessionStore.js';

import {
  handleEmailInput,
  handleVerificationCode,
} from './userController.js';

import {
  handleSdsTextState,
} from './sdsController.js';

import {
  handleTicketTextState,
} from './ticketController.js';

export function registerMessageHandler(bot) {
  bot.on('message_created', async ctx => {
    if (!ctx.message || !ctx.message.body || !ctx.message.body.text) return;
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session) return;

    const text = ctx.message.body.text.trim();

    try {
      if (session.state === State.WAIT_UNLOCK_EMAIL) {
        await handleEmailInput(ctx, text, State.WAIT_UNLOCK_EMAIL);
        return;
      }

      if (session.state === State.WAIT_NEW_USER_EMAIL) {
        await handleEmailInput(ctx, text, State.WAIT_NEW_USER_EMAIL);
        return;
      }

      if (session.state === State.WAIT_EMAIL_VERIFICATION_CODE) {
        await handleVerificationCode(ctx, session, text);
        return;
      }

      const sdsHandled = await handleSdsTextState(ctx, session, text);

      if (sdsHandled) {
        return;
      }

      const ticketHandled = await handleTicketTextState(ctx, session, text);

      if (ticketHandled) {
        return;
      }

      await ctx.reply('Используйте меню или отправьте /start.');
    } catch (error) {
      console.error('message_created error:', error);
      await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
  });
}