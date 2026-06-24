import { State, GlpiTicketStatus } from '../utils/constants.js';
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
  ensureBotUserTicket,
  markTicketSolutionNotified,
  markTicketClosedNotified,
  resetTicketSolutionNotified,
  deleteBotUserTicketByTicketId,
  getBotTicketRating,
  saveBotTicketRating,
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
  getGlpiUserTicketsAsRequester,
} from '../services/glpiService.js';

import {
  collectDownloadedMaxAttachments,
  cleanupDownloadedFiles,
} from '../services/maxFileService.js';

import {
  mainMenuKeyboard,
  helpKeyboard,
  ticketActionsKeyboard,
  ticketListKeyboard,
  ticketFilesKeyboard,
  ticketAttachChoiceKeyboard,
  ticketConfirmKeyboard,
  ticketRateChoiceKeyboard,
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

function isGlpiTicketNotFoundError(error) {
  const message = String(error?.message || '').toLowerCase();

  if (message.includes('error_right_missing')) {
    return false;
  }

  return (
    message.includes('404') ||
    message.includes('error_item_not_found') ||
    message.includes('item not found') ||
    message.includes('not found') ||
    message.includes('не найден') ||
    message.includes('не существует')
  );
}

async function deleteMissingTicketAndReply(ctx, ticketId, title) {
  await deleteBotUserTicketByTicketId(ticketId);

  const titlePart = title ? ` ${title}` : '';
  await ctx.reply(
    `Заявка №${ticketId}${titlePart} больше не существует в GLPI. Я убрал её из списка.`
  );
}

async function ensureGlpiTicketExistsForUser(ctx, ticketId) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших активных заявок.');
    return null;
  }

  try {
    const glpiTicket = await getGlpiTicket(ticketId);

    return {
      localTicket,
      glpiTicket,
    };
  } catch (error) {
    if (isGlpiTicketNotFoundError(error)) {
      await deleteMissingTicketAndReply(ctx, ticketId, '');
      return null;
    }

    throw error;
  }
}

export async function createUserTicket(ctx, title, description, files = []) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await cleanupDownloadedFiles(files);
    await ctx.reply('Учетная запись не найдена. Для входа отправьте /start');
    return;
  }

  const { ticketId, title: ticketTitle } = await createGlpiUserTicket(
    maxUserId,
    user.id,
    title,
    description,
    {
      entityId: user.entity_id,
    }
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

  await saveBotUserTicket(maxUserId, ticketId);

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  const parts = [`Заявка №${ticketId} ${ticketTitle} создана.`];

  if (uploadedFiles.length > 0) {
    parts.push(`Всего вложений: ${uploadedFiles.length}.`);
  }

  if (uploadError) {
    parts.push('Заявка создана, но часть вложений не удалось загрузить в GLPI.');
  }

  await ctx.reply(parts.join('\n'), {
    attachments: [mainMenuKeyboard(maxUserId)],
  });
}

export async function showUserTickets(ctx) {
  const maxUserId = ctx.user.user_id;
  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await ctx.reply('Учетная запись не найдена. Для входа отправьте /start');
    return;
  }

  const localTickets = await getBotUserTickets(maxUserId, 20);
  const localIds = new Set();

  const keyboardItems = [];

  for (const ticket of localTickets) {
    const ticketId = Number(ticket.glpi_ticket_id || 0);
    if (!ticketId) continue;
    localIds.add(ticketId);

    try {
      const glpiTicket = await getGlpiTicket(ticketId);
      const status = Number(glpiTicket.status || 0);

      if (status === GlpiTicketStatus.CLOSED) continue;

      const title = stripHtml(glpiTicket.name || '');
      await ensureBotUserTicket(maxUserId, ticketId);

      keyboardItems.push({ ticketId, title: truncateText(title, 50), statusLabel: getTicketStatusLabel(status) });
    } catch (err) {
      if (isGlpiTicketNotFoundError(err)) {
        await deleteBotUserTicketByTicketId(ticketId);
      }
    }
  }

  const glpiTickets = await getGlpiUserTicketsAsRequester(user.id, { limit: 20 });

  for (const glpiTicket of glpiTickets) {
    const ticketId = glpiTicket.ticketId;
    if (!ticketId || localIds.has(ticketId)) continue;

    try {
      const full = await getGlpiTicket(ticketId);
      const status = Number(full.status || 0);

      if (status === GlpiTicketStatus.CLOSED) continue;

      const title = stripHtml(full.name || '');
      keyboardItems.push({ ticketId, title: truncateText(title, 50), statusLabel: getTicketStatusLabel(status) });
    } catch (err) {
      if (!isGlpiTicketNotFoundError(err)) {
        console.error('showUserTickets external item error:', ticketId, err.message);
      }
    }
  }

  if (keyboardItems.length === 0) {
    await ctx.reply('У вас пока нет заявок.', {
      attachments: [mainMenuKeyboard(maxUserId)],
    });
    return;
  }

  await ctx.reply('Выберите заявку:', {
    attachments: [ticketListKeyboard(keyboardItems)],
  });
}

export async function showTicketDetails(ctx, ticketId) {
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    return;
  }

  const { localTicket, glpiTicket: ticket } = checked;
  const maxUserId = ctx.user.user_id;
  const status = Number(ticket.status || 0);
  const title = stripHtml(ticket.name || `Заявка №${ticketId}`);
  const content = stripHtml(ticket.content || '');

  await ensureBotUserTicket(maxUserId, ticketId);

  const followups = await getGlpiTicketFollowups(ticketId);
  const lastFollowups = [...followups]
    .filter(item => Number(item.is_private || 0) !== 1)
    .slice(-3)
    .map(item => stripHtml(item.content || ''))
    .filter(Boolean);

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

  await ctx.reply(parts.join('\n'), {
    attachments: [ticketActionsKeyboard(ticketId, status)],
  });
}

export async function addUserCommentToTicket(ctx, ticketId, commentText, files = []) {
  const maxUserId = ctx.user.user_id;
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    await cleanupDownloadedFiles(files);
    return;
  }

  const { localTicket, glpiTicket } = checked;
  const ticketTitle = stripHtml(glpiTicket.name || '');

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
  });

  const titlePart = ticketTitle ? ` ${ticketTitle}` : '';
  const parts = [`Комментарий добавлен в заявку №${ticketId}${titlePart}.`];

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
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    return;
  }

  const { localTicket, glpiTicket } = checked;
  const ticketTitle = stripHtml(glpiTicket.name || '');

  const { followupId, content } = await acceptGlpiTicketSolution(ticketId, maxUserId);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await markTicketSolutionNotified(ticketId);
  await ensureBotUserTicket(maxUserId, ticketId);
  await markTicketClosedNotified(ticketId);

  setSession(maxUserId, {
    state: State.WAIT_RATING_CHOICE,
    ticketId,
  });

  await ctx.reply('Вы остались довольны качеством нашей работы?', {
    attachments: [ticketRateChoiceKeyboard(ticketId)],
  });
}

export async function rejectTicketSolution(ctx, ticketId, reason) {
  const maxUserId = ctx.user.user_id;
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    return;
  }

  const { localTicket, glpiTicket } = checked;
  const ticketTitle = stripHtml(glpiTicket.name || '');

  const { followupId, content } = await rejectGlpiTicketSolution(ticketId, reason);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await ensureBotUserTicket(maxUserId, ticketId);
  await resetTicketSolutionNotified(ticketId);

  setSession(maxUserId, {
    state: State.IDLE,
  });

  const titlePart = ticketTitle ? ` ${ticketTitle}` : '';
  await ctx.reply(`Решение по заявке №${ticketId}${titlePart} отклонено.\nЗаявка вернулась в работу`);
}

export async function rateTicket(ctx, ticketId, rating, comment = null) {
  const maxUserId = ctx.user.user_id;
  const normalizedRating = Number(rating || 0);

  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших активных заявок.');
    return;
  }

  const existingRating = await getBotTicketRating(ticketId);

  if (existingRating) {
    await ctx.reply('Ваша оценка уже учтена.');
    return;
  }

  const saved = await saveBotTicketRating(maxUserId, ticketId, normalizedRating, comment);

  if (!saved) {
    await ctx.reply('Ваша оценка уже учтена.');
    return;
  }

  setSession(maxUserId, { state: State.IDLE });

  if (normalizedRating === 1) {
    await ctx.reply('Ваша оценка учтена. Спасибо :)');
  } else {
    await ctx.reply('Ваша оценка учтена');
  }
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

  const filesCount = files.length;

  setSession(maxUserId, {
    state: State.WAIT_TICKET_CONFIRM,
    ticketDraft: {
      title,
      description,
      files,
    },
  });

  const parts = [
    'Проверьте данные заявки',
    '',
    `Тема: ${title}`,
    `Описание: ${description}`,
    `Вложений: ${filesCount}`,
  ];

  await ctx.reply(parts.join('\n'), {
    attachments: [ticketConfirmKeyboard()],
  });
}

export async function handleTicketTextState(ctx, session, text) {
  const maxUserId = ctx.user.user_id;
  const safeText = String(text || '').trim();

  if (session.state === State.WAIT_NEW_TICKET_TITLE) {
    if (safeText.length < 3) {
      await ctx.reply('Заголовок слишком короткий\nВведите понятный заголовок заявки:');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_DESCRIPTION;
    session.ticketDraft = {
      title: safeText,
      description: '',
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply('Подробно опишите Ваш запрос или проблему');
    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_DESCRIPTION) {
    if (safeText.length < 5) {
      await ctx.reply('Описание слишком короткое\nОпишите обращение подробнее');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_FILES;
    session.ticketDraft = {
      ...(session.ticketDraft || {}),
      description: safeText,
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply('Описание принято.', {
      attachments: [ticketAttachChoiceKeyboard()],
    });

    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_FILES) {
    const incomingFiles = await collectDownloadedMaxAttachments(ctx);

    if (incomingFiles.length > 0) {
      const draftFiles = getDraftFiles(session);
      draftFiles.push(...incomingFiles);
      session.ticketDraft.files = draftFiles;

      setSession(maxUserId, session);

      await ctx.reply(`Файл добавлен к заявке\nВсего вложений: ${draftFiles.length}`, {
        attachments: [ticketFilesKeyboard(draftFiles.length)],
      });

      return true;
    }

    await ctx.reply('Отправьте скриншоты или файлы', {
      attachments: [ticketFilesKeyboard(getDraftFiles(session).length)],
    });

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

    if (safeText.length < 2 && files.length === 0) {
      await cleanupDownloadedFiles(files);
      await ctx.reply('Введите текст комментария или приложите файл:');
      return true;
    }

    await addUserCommentToTicket(ctx, session.ticketId, safeText, files);
    return true;
  }

  if (session.state === State.WAIT_REJECT_SOLUTION_REASON) {
    if (!session.ticketId) {
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Заявка не выбрана.');
      return true;
    }

    if (safeText.length < 3) {
      await ctx.reply('Укажите причину отклонения решения:');
      return true;
    }

    await rejectTicketSolution(ctx, session.ticketId, safeText);
    return true;
  }

  if (session.state === State.WAIT_NEGATIVE_RATING_REASON) {
    if (!session.ticketId) {
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Заявка не выбрана.');
      return true;
    }

    if (safeText.length < 3) {
      await ctx.reply('Расскажите, что было не так?');
      return true;
    }

    const existingRating = await getBotTicketRating(session.ticketId);
    if (!existingRating) {
      await saveBotTicketRating(maxUserId, session.ticketId, 0, safeText);
    }

    const content = [
      'Пользователь оставил негативный отзыв:',
      '',
      safeText,
    ].join('\n');

    await addGlpiTicketFollowup(session.ticketId, content);

    setSession(maxUserId, { state: State.IDLE });
    await ctx.reply('Ваша оценка учтена');
    return true;
  }

  return false;
}

export function registerTicketActions(bot) {
  bot.action('menu:start_auth', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;

    setSession(maxUserId, {
      state: State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply('Введите Ваш корпоративный email');
  });

  bot.action('menu:new', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;

    try {
      const user = await findGlpiUserByMaxId(maxUserId);

      if (!user) {
        await ctx.reply('Учетная запись не найдена. Для входа отправьте /start');
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

      await ctx.reply('Обозначьте тему заявки');
    } catch (error) {
      console.error('menu:new error:', error);
      await ctx.reply('Ошибка. Попробуйте позже.');
    }
  });

  bot.action('ticket:start_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Черновик заявки не найден.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
      return;
    }

    await ctx.reply('Отправьте скриншоты или файлы', {
      attachments: [ticketFilesKeyboard(getDraftFiles(session).length)],
    });
  });

  bot.action('ticket:create_with_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Черновик заявки не найден. Возможно, сессия сбросилась.\nНачните создание заявки заново.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
      return;
    }

    try {
      await finishTicketDraft(ctx, session, true);
    } catch (error) {
      console.error('ticket:create_with_files error:', error);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Ошибка при создании заявки. Попробуйте позже.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
    }
  });

  bot.action('ticket:create_without_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Черновик заявки не найден. Возможно, сессия сбросилась.\nНачните создание заявки заново.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
      return;
    }

    try {
      await finishTicketDraft(ctx, session, false);
    } catch (error) {
      console.error('ticket:create_without_files error:', error);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Ошибка при создании заявки. Попробуйте позже.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
    }
  });

  bot.action('ticket:confirm_create', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_TICKET_CONFIRM) {
      await ctx.reply('Черновик заявки не найден.\nНачните создание заявки заново.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
      return;
    }

    const draft = session.ticketDraft || {};
    const title = String(draft.title || '').trim();
    const description = String(draft.description || '').trim();
    const files = Array.isArray(draft.files) ? draft.files : [];

    if (!title || !description) {
      await cancelDraftFiles(session);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Черновик заявки поврежден. Начните создание заявки заново.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
      return;
    }

    try {
      await createUserTicket(ctx, title, description, files);
    } catch (error) {
      console.error('ticket:confirm_create error:', error);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Ошибка при создании заявки. Попробуйте позже.', {
        attachments: [mainMenuKeyboard(maxUserId)],
      });
    }
  });

  bot.action('menu:list', async ctx => {
    try {
      await showUserTickets(ctx);
    } catch (error) {
      console.error('menu:list error:', error);
      await ctx.reply('Ошибка при загрузке заявок. Попробуйте позже.');
    }
  });

  bot.action('menu:back', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;

    try {
      const session = getSession(maxUserId);

      if (session?.state === State.WAIT_NEW_TICKET_FILES || session?.state === State.WAIT_TICKET_CONFIRM) {
        await cancelDraftFiles(session);
      }

      const user = await findGlpiUserByMaxId(maxUserId);

      if (user) {
        setSession(maxUserId, {
          state: State.IDLE,
          glpiUserId: user.id,
        });

        await ctx.reply('Главное меню:', {
          attachments: [mainMenuKeyboard(maxUserId)],
        });

        return;
      }

      await ctx.reply('Для входа отправьте /start');
    } catch (error) {
      console.error('menu:back error:', error);
      await ctx.reply('Для входа отправьте /start');
    }
  });

  bot.action('menu:help', async ctx => {
    await ctx.reply(
      [
        'Бот для работы с заявками.',
        '',
        'Новая — создать заявку.',
        'Выбрать — открыть свои заявки.',
        '',
        'В заявке можно:',
        '• Добавить комментарий (Новая/В работе/Ожидание)',
        '• Принять решение (Удовлетворительно)',
        '• Отклонить решение (Неудовлетворительно) с комментарием',
        '',
        'Создание заявки:',
        '1. Заголовок.',
        '2. Описание.',
        '3. Прикрепление файлов.',
        '4. Создание заявки.',
      ].join('\n'),
      {
        attachments: [helpKeyboard()],
      }
    );
  });

  bot.action('menu:logout', async ctx => {
    if (ctx.user && ctx.user.user_id) {
      const session = getSession(ctx.user.user_id);

      if (session?.state === State.WAIT_NEW_TICKET_FILES || session?.state === State.WAIT_TICKET_CONFIRM) {
        await cancelDraftFiles(session);
      }

      deleteSession(ctx.user.user_id);
    }

    await ctx.reply('Сессия завершена. Отправьте /start для входа.');
  });

  bot.action(/^ticket:open:(\d+)$/, async ctx => {
    const ticketId = Number(ctx.match[1]);
    try {
      await showTicketDetails(ctx, ticketId);
    } catch (error) {
      console.error('ticket:open error:', error);
      await ctx.reply('Ошибка при загрузке заявки. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:comment:(\d+)$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const maxUserId = ctx.user.user_id;

    try {
      const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

      if (!checked) {
        return;
      }

      const { localTicket, glpiTicket } = checked;
      const status = Number(glpiTicket.status || 0);

      if (status === GlpiTicketStatus.CLOSED) {
        await ctx.reply('Заявка закрыта. Комментарии к закрытым заявкам нельзя добавлять.');
        return;
      }

      const ticketTitle = stripHtml(glpiTicket.name || '');

      setSession(maxUserId, {
        state: State.WAIT_TICKET_COMMENT,
        ticketId,
      });

      const titlePart = ticketTitle ? ` ${ticketTitle}` : '';
      await ctx.reply(`Введите комментарий для заявки №${ticketId}${titlePart}.\nМожно приложить фото или файл.`);
    } catch (error) {
      console.error('ticket:comment error:', error);
      await ctx.reply('Ошибка. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:accept:(\d+)$/, async ctx => {
    const ticketId = Number(ctx.match[1]);
    try {
      await acceptTicketSolution(ctx, ticketId);
    } catch (error) {
      console.error('ticket:accept error:', error);
      await ctx.reply('Ошибка при принятии решения. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:reject:(\d+)$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const maxUserId = ctx.user.user_id;

    try {
      const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

      if (!checked) {
        return;
      }

      const { localTicket, glpiTicket } = checked;
      const ticketTitle = stripHtml(glpiTicket.name || '');

      setSession(maxUserId, {
        state: State.WAIT_REJECT_SOLUTION_REASON,
        ticketId,
      });

      const titlePart = ticketTitle ? ` ${ticketTitle}` : '';
      await ctx.reply(`Расскажите, почему вы отклоняете решение по заявке №${ticketId}${titlePart}:`);
    } catch (error) {
      console.error('ticket:reject error:', error);
      await ctx.reply('Ошибка. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:rate:(\d+):([0-5])$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const rating = Number(ctx.match[2]);

    try {
      await rateTicket(ctx, ticketId, rating);
    } catch (error) {
      console.error('ticket:rate error:', error);
      await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:rate_negative:(\d+)$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const maxUserId = ctx.user.user_id;
    const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

    if (!checked) {
      return;
    }

    const { localTicket } = checked;

    setSession(maxUserId, {
      state: State.WAIT_NEGATIVE_RATING_REASON,
      ticketId,
    });

    await ctx.reply('Нам жаль, что Вы остались недовольны результатом\nПомогите нам стать лучше. Расскажите, что было не так?');
  });
}
