import {
  getActiveBotUserTickets,
  updateBotUserTicketStatus,
  isFollowupKnown,
  markFollowupAsKnown,
  markTicketSolutionNotified,
  markTicketClosedNotified,
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
} from '../ui/keyboards.js';

let ticketPollingInProgress = false;

export async function pollUserTickets(bot) {
  if (ticketPollingInProgress) {
    return;
  }

  ticketPollingInProgress = true;

  try {
    const tickets = await getActiveBotUserTickets(50);

    for (const localTicket of tickets) {
      try {
        const ticketId = localTicket.glpi_ticket_id;
        const ticket = await getGlpiTicket(ticketId);
        const status = Number(ticket.status || 0);
        const title = stripHtml(ticket.name || localTicket.title || '');

        await updateBotUserTicketStatus(ticketId, status, title);

        const followups = await getGlpiTicketFollowups(ticketId);

        for (const followup of followups) {
          const followupId = Number(followup.id || 0);

          if (!followupId) {
            continue;
          }

          // Важно: приватные комментарии инженеров пользователю не отправляем.
          if (Number(followup.is_private || 0) === 1) {
            continue;
          }

          const known = await isFollowupKnown(ticketId, followupId);

          if (known) {
            continue;
          }

          const content = stripHtml(followup.content || '');

          await markFollowupAsKnown(ticketId, followupId, content, true);

          if (!content) {
            continue;
          }

          await bot.api.sendMessageToUser(
            localTicket.max_id,
            [
              `Новый комментарий по заявке №${ticketId}:`,
              '',
              truncateText(content, 3000),
            ].join('\n'),
            {
              attachments: [ticketActionsKeyboard(ticketId, status)],
            }
          );
        }

        if (status === 5 && Number(localTicket.solution_notified || 0) === 0) {
          const solutionText = await getLatestTicketSolutionText(ticketId);

          await markTicketSolutionNotified(ticketId);

          await bot.api.sendMessageToUser(
            localTicket.max_id,
            [
              `По заявке №${ticketId} предложено решение.`,
              '',
              solutionText ? truncateText(solutionText, 3000) : 'Текст решения не указан.',
              '',
              'Примите или отклоните решение.',
            ].join('\n'),
            {
              attachments: [ticketActionsKeyboard(ticketId, 5)],
            }
          );
        }

        if (status === 6 && Number(localTicket.closed_notified || 0) === 0) {
          await markTicketClosedNotified(ticketId);

          await bot.api.sendMessageToUser(
            localTicket.max_id,
            `Заявка №${ticketId} закрыта.`
          );
        }
      } catch (err) {
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