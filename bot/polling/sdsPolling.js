import {
  getPendingSdsRequests,
  updateSdsRequestTicketStatus,
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
    const requests = await getPendingSdsRequests(20);

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
        console.error(
          'pollPendingSdsRequests item error:',
          request.glpi_ticket_id,
          err.message
        );
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