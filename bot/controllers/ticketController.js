import { State } from '../utils/constants.js';
import {
  stripHtml,
  truncateText,
  getTicketStatusLabel,
} from '../utils/textUtils.js';

import {
  setSession,
  deleteSession,
} from '../state/sessionStore.js';

import {
  findGlpiUserByMaxId,
  saveBotUserTicket,
  getBotUserTicket,
  getBotUserTickets,
  markFollowupAsKnown,
  updateBotUserTicketStatus,
  markTicketClosedNotified,
  resetTicketSolutionNotified,
} from '../services/dbService.js';

import {
  getGlpiTicket,
  getGlpiTicketFollowups,
  getLatestTicketSolutionText,
  createGlpiUserTicket,
  addGlpiTicketFollowup,
  acceptGlpiTicketSolution,
  rejectGlpiTicketSolution,
} from '../services/glpiService.js';

import {
  mainMenuKeyboard,
  ticketActionsKeyboard,
} from '../ui/keyboards.js';

export async function createUserTicket(ctx, content) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  const { ticketId, title } = await createGlpiUserTicket(
    maxUserId,
    user.id,
    content
  );

  await saveBotUserTicket(maxUserId, user.id, ticketId, title, 1);

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  await ctx.reply(`Заявка №${ticketId} создана.`, {
    attachments: [ticketActionsKeyboard(ticketId, 1)],
  });
}

export async function showUserTickets(ctx) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  const tickets = await getBotUserTickets(maxUserId, 10);

  if (tickets.length === 0) {
    await ctx.reply('У вас пока нет заявок, созданных через MAX.', {
      attachments: [mainMenuKeyboard()],
    });
    return;
  }

  const rows = [];

  for (const ticket of tickets) {
    try {
      const glpiTicket = await getGlpiTicket(ticket.glpi_ticket_id);
      const status = Number(glpiTicket.status || ticket.status || 0);
      const title = stripHtml(glpiTicket.name || ticket.title || '');

      await updateBotUserTicketStatus(ticket.glpi_ticket_id, status, title);

      rows.push([
        {
          type: 'callback',
          text: `№${ticket.glpi_ticket_id} — ${getTicketStatusLabel(status)}`,
          payload: `ticket:open:${ticket.glpi_ticket_id}`,
        },
      ]);
    } catch (err) {
      rows.push([
        {
          type: 'callback',
          text: `№${ticket.glpi_ticket_id} — недоступна`,
          payload: `ticket:open:${ticket.glpi_ticket_id}`,
        },
      ]);
    }
  }

  rows.push([
    {
      type: 'callback',
      text: 'Назад',
      payload: 'menu:back',
    },
  ]);

  // В MAX SDK лучше использовать Keyboard, а не обычные объекты.
  // Поэтому ниже оставляем безопасную ручную сборку через импортированный Keyboard не делаем,
  // а используем mainMenuKeyboard только для главного меню.
  // Если твой SDK не примет такие объекты, скажи — заменим на Keyboard.button.callback.
  const { Keyboard } = await import('@maxhub/max-bot-api');
  const keyboardRows = rows.map(row =>
    row.map(btn => Keyboard.button.callback(btn.text, btn.payload))
  );

  await ctx.reply('Выберите заявку:', {
    attachments: [Keyboard.inlineKeyboard(keyboardRows)],
  });
}

export async function showTicketDetails(ctx, ticketId) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const ticket = await getGlpiTicket(ticketId);
  const status = Number(ticket.status || 0);
  const title = stripHtml(ticket.name || localTicket.title || `Заявка №${ticketId}`);
  const content = stripHtml(ticket.content || '');

  await updateBotUserTicketStatus(ticketId, status, title);

  const followups = await getGlpiTicketFollowups(ticketId);
  const lastFollowups = [...followups]
    .filter(item => Number(item.is_private || 0) !== 1)
    .slice(-3)
    .map(item => stripHtml(item.content || ''))
    .filter(Boolean);

  const solutionText = status === 5 || status === 6
    ? await getLatestTicketSolutionText(ticketId)
    : '';

  const parts = [
    `Заявка №${ticketId}`,
    `Тема: ${title}`,
    `Статус: ${getTicketStatusLabel(status)}`,
    '',
    'Описание:',
    truncateText(content, 1200),
  ];

  if (lastFollowups.length > 0) {
    parts.push('', 'Последние комментарии:');

    for (const text of lastFollowups) {
      parts.push(`— ${truncateText(text, 500)}`);
    }
  }

  if (solutionText) {
    parts.push('', 'Решение:', truncateText(solutionText, 1000));
  }

  await ctx.reply(parts.join('\n'), {
    attachments: [ticketActionsKeyboard(ticketId, status)],
  });
}

export async function addUserCommentToTicket(ctx, ticketId, commentText) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const content = [
    'Комментарий пользователя из MAX:',
    '',
    commentText,
  ].join('\n');

  const followupId = await addGlpiTicketFollowup(ticketId, content);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: localTicket.glpi_user_id,
  });

  await ctx.reply(`Комментарий добавлен в заявку №${ticketId}.`);
  await showTicketDetails(ctx, ticketId);
}

export async function acceptTicketSolution(ctx, ticketId) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const { followupId, content } = await acceptGlpiTicketSolution(ticketId, maxUserId);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await updateBotUserTicketStatus(ticketId, 6);
  await markTicketClosedNotified(ticketId);

  await ctx.reply(`Решение по заявке №${ticketId} принято. Заявка закрыта.`);
}

export async function rejectTicketSolution(ctx, ticketId, reason) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const { followupId, content } = await rejectGlpiTicketSolution(ticketId, reason);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await updateBotUserTicketStatus(ticketId, 2);
  await resetTicketSolutionNotified(ticketId);

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: localTicket.glpi_user_id,
  });

  await ctx.reply(`Решение по заявке №${ticketId} отклонено. Комментарий отправлен инженерам.`);
}

export async function handleTicketTextState(ctx, session, text) {
  const maxUserId = ctx.user.user_id;

  if (session.state === State.WAIT_NEW_TICKET_CONTENT) {
    if (text.length < 5) {
      await ctx.reply('Опишите обращение подробнее:');
      return true;
    }

    await createUserTicket(ctx, text);
    return true;
  }

  if (session.state === State.WAIT_TICKET_COMMENT) {
    if (!session.ticketId) {
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Заявка не выбрана.');
      return true;
    }

    if (text.length < 2) {
      await ctx.reply('Введите текст комментария:');
      return true;
    }

    await addUserCommentToTicket(ctx, session.ticketId, text);
    return true;
  }

  if (session.state === State.WAIT_REJECT_SOLUTION_REASON) {
    if (!session.ticketId) {
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Заявка не выбрана.');
      return true;
    }

    if (text.length < 3) {
      await ctx.reply('Укажите причину отклонения решения:');
      return true;
    }

    await rejectTicketSolution(ctx, session.ticketId, text);
    return true;
  }

  return false;
}

export function registerTicketActions(bot) {
  bot.action('menu:new', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const user = await findGlpiUserByMaxId(maxUserId);

    if (!user) {
      await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
      return;
    }

    setSession(maxUserId, {
      state: State.WAIT_NEW_TICKET_CONTENT,
      glpiUserId: user.id,
    });

    await ctx.reply('Опишите обращение. Я создам заявку в SDS-helpdesk.');
  });

  bot.action('menu:list', async ctx => {
    await showUserTickets(ctx);
  });

  bot.action('menu:back', async ctx => {
    const maxUserId = ctx.user.user_id;
    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      setSession(maxUserId, {
        state: State.IDLE,
        glpiUserId: user.id,
      });

      await ctx.reply('Главное меню:', {
        attachments: [mainMenuKeyboard()],
      });

      return;
    }

    await ctx.reply('Отправьте /start для входа.');
  });

  bot.action('menu:help', async ctx => {
    await ctx.reply(
      [
        'Бот для работы с заявками SDS-helpdesk.',
        '',
        'Новая — создать заявку.',
        'Выбрать — открыть свои заявки.',
        'В заявке можно добавить комментарий, принять или отклонить решение.',
      ].join('\n')
    );
  });

  bot.action('menu:logout', async ctx => {
    if (ctx.user && ctx.user.user_id) {
      deleteSession(ctx.user.user_id);
    }

    await ctx.reply('Сессия завершена. Отправьте /start для входа.');
  });

  bot.action(/^ticket:open:(\d+)$/, async ctx => {
    const ticketId = Number(ctx.match[1]);
    await showTicketDetails(ctx, ticketId);
  });

  bot.action(/^ticket:comment:(\d+)$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const maxUserId = ctx.user.user_id;
    const localTicket = await getBotUserTicket(maxUserId, ticketId);

    if (!localTicket) {
      await ctx.reply('Эта заявка не найдена среди ваших заявок.');
      return;
    }

    setSession(maxUserId, {
      state: State.WAIT_TICKET_COMMENT,
      ticketId,
      glpiUserId: localTicket.glpi_user_id,
    });

    await ctx.reply(`Введите комментарий для заявки №${ticketId}:`);
  });

  bot.action(/^ticket:accept:(\d+)$/, async ctx => {
    const ticketId = Number(ctx.match[1]);
    await acceptTicketSolution(ctx, ticketId);
  });

  bot.action(/^ticket:reject:(\d+)$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const maxUserId = ctx.user.user_id;
    const localTicket = await getBotUserTicket(maxUserId, ticketId);

    if (!localTicket) {
      await ctx.reply('Эта заявка не найдена среди ваших заявок.');
      return;
    }

    setSession(maxUserId, {
      state: State.WAIT_REJECT_SOLUTION_REASON,
      ticketId,
      glpiUserId: localTicket.glpi_user_id,
    });

    await ctx.reply(`Укажите, почему вы отклоняете решение по заявке №${ticketId}:`);
  });
}