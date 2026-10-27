import {
  getPendingSdsRequests,
  updateSdsRequestTicketStatus,
  markSdsRequestMissing,
} from '../services/dbService.js';

import {
  getTicketDecision,
} from '../services/glpiService.js';

import {
  handleApprovedSdsRequest,
  handleRejectedSdsRequest,
} from '../controllers/sdsController.js';

let registrationPollingInProgress = false;

export async function pollPendingSdsRequests(bot) {
  if (registrationPollingInProgress) {
    return;
  }

  registrationPollingInProgress = true;

  try {
    let afterId = 0;
    let upToId = null;
    while (true) {
      const requests = await getPendingSdsRequests(20, afterId, upToId);
      if (!requests.length) break;
      if (upToId === null) upToId = Number(requests[0].polling_max_id);
      const cursor = Number(requests[requests.length - 1].id);
      if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(upToId)
          || cursor <= afterId || cursor > upToId) throw new Error('Invalid SDS pagination cursor');
      afterId = cursor;

      for (const request of requests) {
        try {
          const result = await getTicketDecision(request.glpi_ticket_id);

          await updateSdsRequestTicketStatus(
            request.id,
            result.ticketStatus || null
          );

          if (!result.isFinal) {
            continue;
          }

          if (!result.decision) {
            console.log(
              'Registration ticket is final but decision is not recognized:',
              request.glpi_ticket_id
            );
            continue;
          }

          const enrichedRequest = {
            ...request,
            glpi_ticket_status: result.ticketStatus,
            decision_text: result.decision.text,
          };

          if (result.decision.status === 'APPROVED') {
            await handleApprovedSdsRequest(bot, enrichedRequest);
            continue;
          }

          if (result.decision.status === 'REJECTED') {
            await handleRejectedSdsRequest(bot, enrichedRequest);
            continue;
          }
        } catch (err) {
          if (err.status === 404 || err.code === 'ERROR_ITEM_NOT_FOUND') {
            console.log('SDS ticket not found, skipping:', request.glpi_ticket_id);
            await markSdsRequestMissing(request.id);
            continue;
          }

          console.error(
            'pollPendingSdsRequests item error:',
            request.glpi_ticket_id,
            err.message
          );
        }
      }
    }
  } catch (err) {
    console.error('pollPendingSdsRequests error:', err.message);
  } finally {
    registrationPollingInProgress = false;
  }
}

export function startSdsPolling(bot, intervalMs) {
  setInterval(() => {
    pollPendingSdsRequests(bot).catch(err => {
      console.error('registration polling fatal error:', err.message);
    });
  }, intervalMs);

  pollPendingSdsRequests(bot).catch(err => {
    console.error('registration polling startup error:', err.message);
  });
}