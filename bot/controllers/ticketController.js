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
  updateBotUserTicketStatus,
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
  ticketDraftKeyboard,
  ticketAttachKeyboard,
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

async function deleteMissingTicketAndReply(ctx, ticketId) {
  await deleteBotUserTicketByTicketId(ticketId);

  await ctx.reply(
    `Заявка №${ticketId} больше не существует в GLPI. Я убрал её из списка.`
  );
}

async function ensureGlpiTicketExistsForUser(ctx, ticketId) {
  const maxUserId = ctx.user.user_id;
  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
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
      await deleteMissingTicketAndReply(ctx, ticketId);
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
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  console.log('=== BOT CREATE USER TICKET CONTEXT ===');
  console.log('maxUserId:', maxUserId);
  console.log('glpiUserId:', user.id);
  console.log('localUserEntityId:', user.entity_id);

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

  await saveBotUserTicket(maxUserId, user.id, ticketId, ticketTitle, GlpiTicketStatus.NEW);

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
    attachments: [ticketActionsKeyboard(ticketId, GlpiTicketStatus.NEW)],
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
    await ctx.reply('У вас пока нет заявок.', {
      attachments: [mainMenuKeyboard()],
    });
    return;
  }

  const keyboardItems = [];

  for (const ticket of tickets) {
    try {
      const ticketId = Number(ticket.glpi_ticket_id || 0);

      if (!ticketId) {
        continue;
      }

      const glpiTicket = await getGlpiTicket(ticketId);
      const status = Number(glpiTicket.status || ticket.status || 0);
      const title = stripHtml(glpiTicket.name || ticket.title || '');

      await updateBotUserTicketStatus(ticketId, status, title);

      keyboardItems.push({
        ticketId,
        title: truncateText(title, 50),
        statusLabel: getTicketStatusLabel(status),
      });
    } catch (err) {
      if (isGlpiTicketNotFoundError(err)) {
        await deleteBotUserTicketByTicketId(ticket.glpi_ticket_id);
        console.log('Deleted unavailable local ticket:', ticket.glpi_ticket_id);
        continue;
      }

      console.error('showUserTickets item error:', ticket.glpi_ticket_id, err.message);

      keyboardItems.push({
        ticketId: ticket.glpi_ticket_id,
        title: '',
        statusLabel: 'недоступна',
      });
    }
  }

  if (keyboardItems.length === 0) {
    await ctx.reply(
      'Актуальных заявок не найдено.',
      {
        attachments: [mainMenuKeyboard()],
      }
    );
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
    status === GlpiTicketStatus.SOLVED || status === GlpiTicketStatus.CLOSED
      ? await getLatestTicketSolutionText(ticketId)
      : '';

  const rating = await getBotTicketRating(ticketId);

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
    parts.push('', 'Предложенное решение:', truncateText(solutionText, 1000));
  }

  if (rating) {
    const ratingLabel = rating.rating === 1 ? 'Удовлетворительно' : 'Неудовлетворительно';
    parts.push('', `Оценка пользователя: ${ratingLabel}`);
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

  const { localTicket } = checked;

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
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    return;
  }

  const { localTicket } = checked;

  const { followupId, content } = await acceptGlpiTicketSolution(ticketId, maxUserId);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await markTicketSolutionNotified(ticketId);
  await updateBotUserTicketStatus(ticketId, GlpiTicketStatus.CLOSED);
  await markTicketClosedNotified(ticketId);

  const existingRating = await getBotTicketRating(ticketId);

  if (!existingRating) {
    await saveBotTicketRating(maxUserId, ticketId, 1);
  }

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: localTicket.glpi_user_id,
  });

  await ctx.reply(`Решение по заявке №${ticketId} принято. Заявка закрыта. Оценка: Удовлетворительно.`);
}

export async function rejectTicketSolution(ctx, ticketId, reason) {
  const maxUserId = ctx.user.user_id;
  const checked = await ensureGlpiTicketExistsForUser(ctx, ticketId);

  if (!checked) {
    return;
  }

  const { localTicket } = checked;

  const { followupId, content } = await rejectGlpiTicketSolution(ticketId, reason);

  if (followupId) {
    await markFollowupAsKnown(ticketId, followupId, content, true);
  }

  await updateBotUserTicketStatus(ticketId, GlpiTicketStatus.PROCESSING);
  await resetTicketSolutionNotified(ticketId);

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: localTicket.glpi_user_id,
  });

  await ctx.reply(`Решение по заявке №${ticketId} отклонено. Комментарий отправлен инженерам.`);
}

export async function rateTicket(ctx, ticketId, rating) {
  const maxUserId = ctx.user.user_id;
  const normalizedRating = Number(rating || 0);

  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    await ctx.reply('Некорректная оценка. Выберите оценку от 1 до 5.');
    return;
  }

  const localTicket = await getBotUserTicket(maxUserId, ticketId);

  if (!localTicket) {
    await ctx.reply('Эта заявка не найдена среди ваших заявок.');
    return;
  }

  const existingRating = await getBotTicketRating(ticketId);

  if (existingRating) {
    await ctx.reply(`Оценка по заявке №${ticketId} уже сохранена: ${existingRating.rating}/5.`);
    return;
  }

  const saved = await saveBotTicketRating(maxUserId, ticketId, normalizedRating);

  if (!saved) {
    const ratingAfterSave = await getBotTicketRating(ticketId);

    await ctx.reply(
      ratingAfterSave
        ? `Оценка по заявке №${ticketId} уже сохранена: ${ratingAfterSave.rating}/5.`
        : `Оценка по заявке №${ticketId} уже была сохранена.`
    );

    return;
  }

  await ctx.reply(`Спасибо! Оценка ${normalizedRating}/5 по заявке №${ticketId} сохранена.`);
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
  const safeText = String(text || '').trim();

  if (session.state === State.WAIT_NEW_TICKET_TITLE) {
    if (safeText.length < 3) {
      await ctx.reply('Заголовок слишком короткий. Введите понятный заголовок заявки:');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_DESCRIPTION;
    session.ticketDraft = {
      title: safeText,
      description: '',
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply('Введите описание заявки:');
    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_DESCRIPTION) {
    if (safeText.length < 5) {
      await ctx.reply('Описание слишком короткое. Опишите обращение подробнее:');
      return true;
    }

    session.state = State.WAIT_NEW_TICKET_FILES;
    session.ticketDraft = {
      ...(session.ticketDraft || {}),
      description: safeText,
      files: [],
    };

    setSession(maxUserId, session);

    await ctx.reply(
      [
        'Описание принято.',
        '',
        'Хотите прикрепить файлы к заявке?',
      ].join('\n'),
      {
        attachments: [ticketAttachKeyboard()],
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

      await ctx.reply(`Файл добавлен: ${draftFiles.length}.`, {
        attachments: [ticketDraftKeyboard(draftFiles.length)],
      });

      return true;
    }

    const normalizedText = safeText.toLowerCase();

    if (['создать', 'готово', 'готов', 'без файлов', 'пропустить'].includes(normalizedText)) {
      await finishTicketDraft(
        ctx,
        session,
        normalizedText !== 'без файлов' && normalizedText !== 'пропустить'
      );
      return true;
    }

    await ctx.reply('Отправьте файл или нажмите кнопку.', {
      attachments: [ticketDraftKeyboard(getDraftFiles(session).length)],
    });

    return true;
  }

  if (session.state === State.WAIT_NEW_TICKET_CONTENT) {
    const incomingFiles = await collectDownloadedMaxAttachments(ctx);

    if (safeText.length < 5) {
      await cleanupDownloadedFiles(incomingFiles);
      await ctx.reply('Опишите обращение подробнее:');
      return true;
    }

    await createUserTicket(ctx, truncateText(safeText, 80), safeText, incomingFiles);
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

    const existingRating = await getBotTicketRating(session.ticketId);
    if (!existingRating) {
      await saveBotTicketRating(maxUserId, session.ticketId, 0);
    }

    await rejectTicketSolution(ctx, session.ticketId, safeText);
    return true;
  }

  return false;
}

export function registerTicketActions(bot) {
  bot.action('menu:new', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;

    try {
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
        attachments: [mainMenuKeyboard()],
      });
      return;
    }

    await ctx.reply(
      [
        'Отправьте фото или файлы одним или несколькими сообщениями.',
        'Когда закончите — нажмите «Создать» или «Создать без файлов».',
      ].join('\n'),
      {
        attachments: [ticketDraftKeyboard(getDraftFiles(session).length)],
      }
    );
  });

  bot.action('ticket:create_with_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Черновик заявки не найден. Возможно, сессия сбросилась. Начните создание заявки заново.', {
        attachments: [mainMenuKeyboard()],
      });
      return;
    }

    try {
      await finishTicketDraft(ctx, session, true);
    } catch (error) {
      console.error('ticket:create_with_files error:', error);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Ошибка при создании заявки. Попробуйте позже.', {
        attachments: [mainMenuKeyboard()],
      });
    }
  });

  bot.action('ticket:create_without_files', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const maxUserId = ctx.user.user_id;
    const session = getSession(maxUserId);

    if (!session || session.state !== State.WAIT_NEW_TICKET_FILES) {
      await ctx.reply('Черновик заявки не найден. Возможно, сессия сбросилась. Начните создание заявки заново.', {
        attachments: [mainMenuKeyboard()],
      });
      return;
    }

    try {
      await finishTicketDraft(ctx, session, false);
    } catch (error) {
      console.error('ticket:create_without_files error:', error);
      setSession(maxUserId, { state: State.IDLE });
      await ctx.reply('Ошибка при создании заявки. Попробуйте позже.', {
        attachments: [mainMenuKeyboard()],
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
    } catch (error) {
      console.error('menu:back error:', error);
      await ctx.reply('Отправьте /start для входа.');
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

      if (session?.state === State.WAIT_NEW_TICKET_FILES) {
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

      const { localTicket } = checked;

      setSession(maxUserId, {
        state: State.WAIT_TICKET_COMMENT,
        ticketId,
        glpiUserId: localTicket.glpi_user_id,
      });

      await ctx.reply(`Введите комментарий для заявки №${ticketId}. Можно приложить фото или файл.`);
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

      const { localTicket } = checked;

      setSession(maxUserId, {
        state: State.WAIT_REJECT_SOLUTION_REASON,
        ticketId,
        glpiUserId: localTicket.glpi_user_id,
      });

      await ctx.reply(`Укажите, почему вы отклоняете решение по заявке №${ticketId}:`);
    } catch (error) {
      console.error('ticket:reject error:', error);
      await ctx.reply('Ошибка. Попробуйте позже.');
    }
  });

  bot.action(/^ticket:rate:(\d+):([1-5])$/, async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    const ticketId = Number(ctx.match[1]);
    const rating = Number(ctx.match[2]);

    try {
      await rateTicket(ctx, ticketId, rating);
    } catch (error) {
      console.error('ticket:rate error:', error);
      await ctx.reply('Ошибка при сохранении оценки. Попробуйте позже.');
    }
  });
}