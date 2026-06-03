import { State } from '../utils/constants.js';
import {
  stripHtml,
  truncateText,
  getTicketStatusLabel,
} from '../utils/textUtils.js';

import {
  getSession,
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
  ticketFilesKeyboard,
} from '../ui/keyboards.js';

function getDraftFiles(session) {
  if (!session.ticketDraft) {
    session.ticketDraft = {};
  }

  if (!Array.isArray(session.ticketDraft.files)) {
    session.ticketDraft.files = [];
  }

  return session.ticketDraft.files;
}

async function cancelDraftFiles(session) {
  const files = session?.ticketDraft?.files || [];
  await cleanupDownloadedFiles(files);
}

export async function createUserTicket(ctx, title, description, files = []) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await cleanupDownloadedFiles(files);
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  /*
    Заявка создаётся через GLPI API от сервисного аккаунта MAX Bot.

    Автор создания:
      сервисный аккаунт, чей токен указан в GLPI_API_USER_TOKEN.

    Инициатор запроса:
      пользователь GLPI, который авторизовался в MAX-боте.

    Организацию пользователя сюда НЕ передаём.
    Заявка создаётся в env.GLPI_ENTITY_ID, где у сервисного аккаунта есть права.
  */
  const { ticketId, title: ticketTitle } = await createGlpiUserTicket(
    maxUserId,
    user.id,
    title,
    description
  );

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

async function finishTicketDraft(ctx, session, withFiles) {
  const maxUserId = ctx.user.user_id;
  const draft = session.ticketDraft || {};

  const title = String(draft.title || '').trim();
  const description = String(draft.description || '').trim();
  const files = withFiles ? getDraftFiles(session) : [];

  if (!title || !description) {
    await cancelDraftFiles(session);
    setSession(maxUserId, { state: State.IDLE });
    await ctx.reply('Черновик заявки поврежден. Начните создание заявки заново.');
    return;
  }

  if (!withFiles) {
    await cleanupDownloadedFiles(getDraftFiles(session));
  }

  await createUserTicket(ctx, title, description, files);
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
      description: '',
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply('Введите описание заявки:');
    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_DESCRIPTION) {
    if (text.length < 5) {
      await ctx.reply('Описание слишком короткое. Опишите обращение подробнее:');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_FILES;
    session.ticketDraft = {
      ...(session.ticketDraft || {}),
      description: text,
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply(
      [
        'Теперь можно прикрепить фото или файлы.',
        '',
        'Отправьте файлы одним или несколькими сообщениями.',
        'Когда закончите — нажмите кнопку создания заявки.',
      ].join('\n'),
      {
        attachments: [ticketFilesKeyboard(0)],
      }
    );

    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_FILES) {
    const incomingFiles = await collectDownloadedMaxAttachments(ctx);

    if (incomingFiles.length > 0) {
      const draftFiles = getDraftFiles(session);
      draftFiles.push(...incomingFiles);
      session.ticketDraft.files = draftFiles;

      setSession(maxUserId, session);

      await ctx.reply(`Файлы добавлены: ${draftFiles.length}.`, {
        attachments: [ticketFilesKeyboard(draftFiles.length)],
      });

      return true;
    }

    const normalizedText = text.toLowerCase();

    if (['создать', 'готово', 'готов', 'без файлов', 'пропустить'].includes(normalizedText)) {
      await finishTicketDraft(
        ctx,
        session,
        normalizedText !== 'без файлов' && normalizedText !== 'пропустить'
      );
      return true;
    }

    await ctx.reply('Прикрепите файл или нажмите кнопку создания заявки.', {
      attachments: [ticketFilesKeyboard(getDraftFiles(session).length)],
    });

    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_CONTENT) {
    if (text.length < 5) {
      await ctx.reply('Опишите обращение подробнее:');
      return true;
    }

    await createUserTicket(ctx, truncateText(text, 80), text, []);
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
      ticketDraft: {
        title: '',
        description: '',
        files: [],
      },
    });

    await ctx.reply('Введите заголовок заявки:');
  });

  bot.action('ticket:create_with_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Нет активного черновика заявки.');
      return;
    }

    await finishTicketDraft(ctx, session, true);
  });

  bot.action('ticket:create_without_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Нет активного черновика заявки.');
      return;
    }

    await finishTicketDraft(ctx, session, false);
  });

  bot.action('menu:list', async ctx => {
    await showUserTickets(ctx);
  });

  bot.action('menu:back', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (session?.state === State.WAIT_NEW_TICKET_FILES) {
      await cancelDraftFiles(session);
    }

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
        '',
        'Создание заявки:',
        '1. Заголовок.',
        '2. Описание.',
        '3. Прикрепление файлов.',
        '4. Создание заявки.',
      ].join('\n')
    );
  });

  bot.action('menu:logout', async ctx => {
    if (ctx.user && ctx.user.user_id) {
      const session = getSession(ctx.user.user_id);

      if (session?.state === State.WAIT_NEW_TICKET_FILES) {
        await cancelDraftFiles(session);
      }

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