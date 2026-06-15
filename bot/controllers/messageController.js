import { State } from '../utils/constants.js';
import { getSession, setSession } from '../state/sessionStore.js';

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

function hasIncomingAttachments(ctx) {
  const attachments =
    ctx.message?.body?.attachments ||
    ctx.message?.attachments ||
    ctx.message?.body?.message?.attachments ||
    [];

  return Array.isArray(attachments) && attachments.length > 0;
}

export function registerMessageHandler(bot) {
  bot.on('message_created', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session) return;

    const text = String(ctx.message?.body?.text || '').trim();
    const hasFiles = hasIncomingAttachments(ctx);

    if (!text && !hasFiles) return;

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

      if (
        session.state === State.WAIT_NEW_TICKET_FILES ||
        session.state === State.WAIT_TICKET_COMMENT
      ) {
        setSession(maxUserId, { state: State.IDLE });
        await ctx.reply('Произошла ошибка при обработке файла. Попробуйте отправить другой файл или вернитесь в меню.');
      } else {
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
    }
  });
}