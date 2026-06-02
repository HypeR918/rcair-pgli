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
  forceTicketRequesterInDb,
} from '../services/dbService.js';

import {
  getGlpiTicket,
  getGlpiTicketFollowups,
  getLatestTicketSolutionText,
  createGlpiUserTicket,
  addGlpiTicketFollowup,
  acceptGlpiTicketSolution,
  rejectGlpiTicketSolution,
  uploadAndAttachFilesToTicket,
} from '../services/glpiService.js';

import {
  collectDownloadedMaxAttachments,
  cleanupDownloadedFiles,
} from '../services/maxFileService.js';

import {
  mainMenuKeyboard,
  ticketActionsKeyboard,
  ticketListKeyboard,
} from '../ui/keyboards.js';

export async function createUserTicket(ctx, title, description, files = []) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await cleanupDownloadedFiles(files);
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  const { ticketId, title: ticketTitle } = await createGlpiUserTicket(
    maxUserId,
    user.id,
    title,
    description
  );

  // Принудительно выставляем инициатора заявки в БД GLPI.
  // Это заполняет оба поля:
  // 1. glpi_tickets.users_id_recipient
  // 2. glpi_tickets_users type = 1
  await forceTicketRequesterInDb(ticketId, user.id);

  let uploadedFiles = [];
  let uploadError = null;

  try {
    if (files.length > 0) {
      uploadedFiles = await uploadAndAttachFilesToTicket(ticketId, files);
    }
  } catch (error) {
    uploadError = error;
    console.error('uploadAndAttachFilesToTicket error:', error.message);
  } finally {
    await cleanupDownloadedFiles(files);
  }

  await saveBotUserTicket(maxUserId, user.id, ticketId, ticketTitle, 1);

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  const parts = [`Заявка №${ticketId} создана.`];

  if (uploadedFiles.length > 0) {
    parts.push(`Вложения добавлены: ${uploadedFiles.length}.`);
  }

  if (uploadError) {
    parts.push('Заявка создана, но часть вложений не удалось загрузить в GLPI.');
  }

  await ctx.reply(parts.join('\n'), {
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

  const keyboardItems = [];

  for (const ticket of tickets) {
    try {
      const glpiTicket = await getGlpiTicket(ticket.glpi_ticket_id);
      const status = Number(glpiTicket.status || ticket.status || 0);
      const title = stripHtml(glpiTicket.name || ticket.title || '');

      await updateBotUserTicketStatus(ticket.glpi_ticket_id, status, title);

      keyboardItems.push({
        ticketId: ticket.glpi_ticket_id,
        statusLabel: getTicketStatusLabel(status),
      });
    } catch (err) {
      console.error('showUserTickets item error:', ticket.glpi_ticket_id, err.message);

      keyboardItems.push({
        ticketId: ticket.glpi_ticket_id,
        statusLabel: 'недоступна',
      });
    }
  }

  await ctx.reply('Выберите заявку:', {
    attachments: [ticketListKeyboard(keyboardItems)],
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

  const solutionText =
    status === 5 || status === 6
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

export async function addUserCommentToTicket(ctx, ticketId, commentText, files = []) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await cleanupDownloadedFiles(files);
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const content = [
    'Комментарий пользователя из MAX:',
    '',
    commentText || 'Добавлены вложения.',
  ].join('\n');

  const followupId = await addGlpiTicketFollowup(ticketId, content);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  let uploadedFiles = [];
  let uploadError = null;

  try {
    if (files.length > 0) {
      uploadedFiles = await uploadAndAttachFilesToTicket(ticketId, files);
    }
  } catch (error) {
    uploadError = error;
    console.error('uploadAndAttachFilesToTicket comment error:', error.message);
  } finally {
    await cleanupDownloadedFiles(files);
  }

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: localTicket.glpi_user_id,
  });

  const parts = [`Комментарий добавлен в заявку №${ticketId}.`];

  if (uploadedFiles.length > 0) {
    parts.push(`Вложения добавлены: ${uploadedFiles.length}.`);
  }

  if (uploadError) {
    parts.push('Комментарий добавлен, но часть вложений не удалось загрузить.');
  }

  await ctx.reply(parts.join('\n'));
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

  if (session.state === State.WAIT_NEW_TICKET_TITLE) {
    if (text.length < 3) {
      await ctx.reply('Заголовок слишком короткий. Введите понятный заголовок заявки:');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_DESCRIPTION;
    session.ticketDraft = {
      title: text,
    };

    setSession(maxUserId, session);

    await ctx.reply('Теперь введите описание заявки. Можно приложить фото или файл к этому же сообщению.');
    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_DESCRIPTION) {
    const files = await collectDownloadedMaxAttachments(ctx);

    if (text.length < 5) {
      await cleanupDownloadedFiles(files);
      await ctx.reply('Описание слишком короткое. Опишите обращение подробнее:');
      return true;
    }

    const title = session.ticketDraft?.title || 'Заявка из MAX';
    const description = text;

    await createUserTicket(ctx, title, description, files);
    return true;
  }

  // Старая логика, если где-то осталась сессия WAIT_NEW_TICKET_CONTENT.
  if (session.state === State.WAIT_NEW_TICKET_CONTENT) {
    const files = await collectDownloadedMaxAttachments(ctx);

    if (text.length < 5) {
      await cleanupDownloadedFiles(files);
      await ctx.reply('Опишите обращение подробнее:');
      return true;
    }

    await createUserTicket(ctx, truncateText(text, 80), text, files);
    return true;
  }

  if (session.state === State.WAIT_TICKET_COMMENT) {
    const files = await collectDownloadedMaxAttachments(ctx);

    if (!session.ticketId) {
      await cleanupDownloadedFiles(files);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Заявка не выбрана.');
      return true;
    }

    if (text.length < 2 && files.length === 0) {
      await cleanupDownloadedFiles(files);
      await ctx.reply('Введите текст комментария или приложите файл:');
      return true;
    }

    await addUserCommentToTicket(ctx, session.ticketId, text, files);
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
      state: State.WAIT_NEW_TICKET_TITLE,
      glpiUserId: user.id,
      ticketDraft: {},
    });

    await ctx.reply('Введите заголовок заявки:');
  });

  bot.action('menu:list', async ctx => {
    await showUserTickets(ctx);
  });

  bot.action('menu:back', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

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
        'При создании заявки и при комментарии можно приложить фото или файл.',
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

    await ctx.reply(`Введите комментарий для заявки №${ticketId}. Можно приложить фото или файл.`);
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