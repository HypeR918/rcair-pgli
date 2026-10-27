import {
  getActiveBotUserTickets,
  getAuthorizedTicketUser,
  ensureBotUserTicket,
  isFollowupKnown,
  markFollowupAsKnown,
  markTicketSolutionNotified,
  markTicketClosedNotified,
  deleteBotUserTicketByTicketId,
} from '../services/dbService.js';

import {
  getGlpiTicket,
  getGlpiTicketFollowups,
  getLatestTicketSolutionText,
} from '../services/glpiService.js';

import {
  stripHtml,
  truncateText,
} from '../utils/textUtils.js';

import {
  ticketActionsKeyboard,
  ticketSolutionNotificationKeyboard,
} from '../ui/keyboards.js';

let ticketPollingInProgress = false;

function isGlpiTicketNotFoundError(error) {
  return error?.status === 404 || error?.code === 'ERROR_ITEM_NOT_FOUND';
}

async function sendMessageToMaxUser(bot, maxUserId, text, options = {}) {
  if (bot?.api && typeof bot.api.sendMessageToUser === 'function') {
    return await bot.api.sendMessageToUser(maxUserId, text, options);
  }

  if (typeof bot?.sendMessageToUser === 'function') {
    return await bot.sendMessageToUser(maxUserId, text, options);
  }

  throw new Error('MAX sendMessageToUser method was not found');
}

async function notifyNewFollowups(bot, localTicket, ticketId, status) {
  const followups = await getGlpiTicketFollowups(ticketId);
  let title = '';

  try {
    const glpiTicket = await getGlpiTicket(ticketId);
    title = stripHtml(glpiTicket.name || '');
  } catch (e) {
    // ignore
  }

  for (const followup of followups) {
    const followupId = Number(followup.id || 0);

    if (!followupId) {
      continue;
    }

    if (Number(followup.is_private || 0) === 1) {
      continue;
    }

    const known = await isFollowupKnown(ticketId, followupId);

    if (known) {
      continue;
    }

    const content = stripHtml(followup.content || '');

    if (!content) {
      await markFollowupAsKnown(ticketId, followupId, content, true);
      continue;
    }

    if (content.includes('Пользователь принял решение через MAX') ||
        content.includes('Пользователь отклонил решение через MAX') ||
        content.includes('Комментарий пользователя из MAX:')) {
      await markFollowupAsKnown(ticketId, followupId, content, true);
      continue;
    }

    const titlePart = title ? ` ${title}` : '';

    await sendMessageToMaxUser(
      bot,
      localTicket.max_id,
      [
        `Новый комментарий по заявке №${ticketId}${titlePart}:`,
        '',
        truncateText(content, 3000),
      ].join('\n'),
      {
        attachments: [ticketActionsKeyboard(ticketId, status)],
      }
    );

    await markFollowupAsKnown(ticketId, followupId, content, true);
  }
}

async function notifySolutionIfNeeded(bot, localTicket, ticketId, status) {
  if (status !== 5) {
    return;
  }

  if (Number(localTicket.solution_notified || 0) === 1) {
    return;
  }

  const solutionText = await getLatestTicketSolutionText(ticketId);
  let title = '';

  try {
    const glpiTicket = await getGlpiTicket(ticketId);
    title = stripHtml(glpiTicket.name || '');
  } catch (e) {
    // ignore
  }

  const titlePart = title ? ` ${title}` : '';

  await sendMessageToMaxUser(
    bot,
    localTicket.max_id,
    [
      `По заявке №${ticketId}${titlePart} предложено решение.`,
      '',
      solutionText ? truncateText(solutionText, 3000) : 'Текст решения не указан.',
      '',
      'Заявка решена?',
    ].join('\n'),
    {
      attachments: [ticketSolutionNotificationKeyboard(ticketId)],
    }
  );

  await markTicketSolutionNotified(ticketId);
}

async function notifyClosedIfNeeded(bot, localTicket, ticketId, status) {
  if (status !== 6) {
    return;
  }

  if (Number(localTicket.closed_notified || 0) === 1) {
    return;
  }

  let title = '';

  try {
    const glpiTicket = await getGlpiTicket(ticketId);
    title = stripHtml(glpiTicket.name || '');
  } catch (e) {
    // ignore
  }

  const titlePart = title ? ` ${title}` : '';

  await sendMessageToMaxUser(
    bot,
    localTicket.max_id,
    `Заявка №${ticketId}${titlePart} закрыта.`
  );

  await markTicketClosedNotified(ticketId);
}

export async function pollUserTickets(bot) {
  if (ticketPollingInProgress) {
    return;
  }

  ticketPollingInProgress = true;

  const startedAt = Date.now();
  let afterId = 0;
  let upToId = null;
  let scannedCount = 0;
  let batchCount = 0;
  let errorCount = 0;

  try {
    console.log('[TICKET_POLLING] Cycle started');

    while (true) {
      const tickets = await getActiveBotUserTickets(50, afterId, upToId);

      if (tickets.length === 0) {
        break;
      }

      if (upToId === null) {
        upToId = Number(tickets[0].polling_max_id);
      }

      const nextAfterId = Number(tickets[tickets.length - 1].id);

      if (!Number.isSafeInteger(upToId)
          || !Number.isSafeInteger(nextAfterId)
          || nextAfterId <= afterId
          || nextAfterId > upToId) {
        throw new Error('Invalid ticket polling pagination cursor');
      }

      // Advance by the stable row ID, not OFFSET: deletions cannot skip a page.
      afterId = nextAfterId;
      scannedCount += tickets.length;
      batchCount += 1;

      for (const localTicket of tickets) {
        const ticketId = Number(localTicket.glpi_ticket_id || 0);

        if (!ticketId) {
          continue;
        }

        try {
          if (!await getAuthorizedTicketUser(localTicket.max_id, ticketId)) continue;
          const ticket = await getGlpiTicket(ticketId);
          const status = Number(ticket.status || 0);

          await ensureBotUserTicket(localTicket.max_id, ticketId);

          await notifySolutionIfNeeded(bot, localTicket, ticketId, status);
          await notifyClosedIfNeeded(bot, localTicket, ticketId, status);
          await notifyNewFollowups(bot, localTicket, ticketId, status);
        } catch (err) {
          if (isGlpiTicketNotFoundError(err)) {
            await deleteBotUserTicketByTicketId(ticketId);
            console.log('Deleted unavailable local ticket:', ticketId);
            continue;
          }

          errorCount += 1;
          console.error(
            'pollUserTickets item error:',
            localTicket.glpi_ticket_id,
            err.message
          );
        }
      }
    }

    console.log(
      `[TICKET_POLLING] Cycle complete: rows=${scannedCount}, batches=${batchCount}, errors=${errorCount}, duration_ms=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error('pollUserTickets error:', err.message);
  } finally {
    ticketPollingInProgress = false;
  }
}

export function startTicketPolling(bot, intervalMs) {
  setInterval(() => {
    pollUserTickets(bot).catch(err => {
      console.error('ticket polling fatal error:', err.message);
    });
  }, intervalMs);

  pollUserTickets(bot).catch(err => {
    console.error('ticket polling startup error:', err.message);
  });
}