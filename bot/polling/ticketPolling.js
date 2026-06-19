import {
  getActiveBotUserTickets,
  updateBotUserTicketStatus,
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

    const title = stripHtml(localTicket.title || '');

    await sendMessageToMaxUser(
      bot,
      localTicket.max_id,
      [
        `Новый комментарий по заявке №${ticketId} ${title}:`,
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
  const title = stripHtml(localTicket.title || '');

  await sendMessageToMaxUser(
    bot,
    localTicket.max_id,
    [
      `По заявке №${ticketId} ${title} предложено решение.`,
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

  const title = stripHtml(localTicket.title || '');

  await sendMessageToMaxUser(
    bot,
    localTicket.max_id,
    `Заявка №${ticketId} ${title} закрыта.`
  );

  await markTicketClosedNotified(ticketId);
}

export async function pollUserTickets(bot) {
  if (ticketPollingInProgress) {
    return;
  }

  ticketPollingInProgress = true;

  try {
    const tickets = await getActiveBotUserTickets(50);

    for (const localTicket of tickets) {
      const ticketId = Number(localTicket.glpi_ticket_id || 0);

      if (!ticketId) {
        continue;
      }

      try {
        const ticket = await getGlpiTicket(ticketId);
        const status = Number(ticket.status || 0);
        const title = stripHtml(ticket.name || localTicket.title || '');

        await updateBotUserTicketStatus(ticketId, status, title);

        await notifySolutionIfNeeded(bot, localTicket, ticketId, status);
        await notifyClosedIfNeeded(bot, localTicket, ticketId, status);
        await notifyNewFollowups(bot, localTicket, ticketId, status);
      } catch (err) {
        if (isGlpiTicketNotFoundError(err)) {
          await deleteBotUserTicketByTicketId(ticketId);
          console.log('Deleted unavailable local ticket:', ticketId);
          continue;
        }

        console.error(
          'pollUserTickets item error:',
          localTicket.glpi_ticket_id,
          err.message
        );
      }
    }
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