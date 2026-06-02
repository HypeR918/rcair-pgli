import axios from 'axios';
import { env } from '../config/env.js';
import { GlpiTicketStatus } from '../utils/constants.js';
import {
  stripHtml,
  truncateText,
  parseDecisionText,
} from '../utils/textUtils.js';

function getGlpiApiBaseUrl() {
  const url = String(env.GLPI_API_URL || '').trim();

  if (!url) {
    throw new Error('GLPI_API_URL is not configured');
  }

  return url.replace(/\/+$/, '');
}

function getGlpiApiHeaders(sessionToken) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (sessionToken) {
    headers['Session-Token'] = sessionToken;
  }

  if (env.GLPI_API_APP_TOKEN) {
    headers['App-Token'] = env.GLPI_API_APP_TOKEN;
  }

  return headers;
}

export async function glpiInitSession() {
  if (!env.GLPI_API_USER_TOKEN) {
    throw new Error('GLPI_API_USER_TOKEN is not configured');
  }

  const baseUrl = getGlpiApiBaseUrl();

  const res = await axios.get(`${baseUrl}/initSession`, {
    headers: {
      ...getGlpiApiHeaders(),
      Authorization: `user_token ${env.GLPI_API_USER_TOKEN}`,
    },
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300 || !res.data?.session_token) {
    console.error('GLPI initSession failed:', res.status, res.data);
    throw new Error('GLPI initSession failed');
  }

  return res.data.session_token;
}

export async function glpiKillSession(sessionToken) {
  if (!sessionToken) return;

  try {
    const baseUrl = getGlpiApiBaseUrl();

    await axios.get(`${baseUrl}/killSession`, {
      headers: getGlpiApiHeaders(sessionToken),
      validateStatus: () => true,
    });
  } catch (err) {
    console.error('GLPI killSession error:', err.message);
  }
}

export async function glpiApiRequest(method, path, data = null) {
  const sessionToken = await glpiInitSession();

  try {
    const baseUrl = getGlpiApiBaseUrl();
    const lowerMethod = method.toLowerCase();

    const needsWriteSession = ['post', 'put', 'patch', 'delete'].includes(lowerMethod);
    const separator = path.includes('?') ? '&' : '?';
    const finalPath = needsWriteSession
      ? `${path}${separator}session_write=true`
      : path;

    const config = {
      method,
      url: `${baseUrl}${finalPath}`,
      headers: getGlpiApiHeaders(sessionToken),
      validateStatus: () => true,
    };

    // GLPI запрещает body у GET-запросов.
    if (data !== null && data !== undefined && lowerMethod !== 'get') {
      config.data = data;
    }

    const res = await axios(config);

    if (res.status < 200 || res.status >= 300) {
      console.error('GLPI API request failed:', method, finalPath, res.status, res.data);
      throw new Error(`GLPI API request failed: ${res.status}`);
    }

    return res.data;
  } finally {
    await glpiKillSession(sessionToken);
  }
}

export async function getGlpiTicket(ticketId) {
  return await glpiApiRequest('get', `/Ticket/${ticketId}`);
}

export async function updateGlpiTicket(ticketId, input) {
  return await glpiApiRequest('put', `/Ticket/${ticketId}`, {
    input: {
      id: ticketId,
      ...input,
    },
  });
}

export async function createGlpiTicket(title, content, options = {}) {
  const input = {
    name: title,
    content,
    entities_id: options.entityId ?? env.GLPI_ENTITY_ID,
    type: options.type ?? 2,
    urgency: options.urgency ?? 3,
    impact: options.impact ?? 3,
    priority: options.priority ?? 3,
  };

  const categoryId =
    options.categoryId !== undefined
      ? Number(options.categoryId)
      : env.GLPI_DEFAULT_REQUEST_CATEGORY_ID;

  const groupId =
    options.groupId !== undefined
      ? Number(options.groupId)
      : env.GLPI_DEFAULT_ASSIGN_GROUP_ID;

  if (categoryId > 0) {
    input.itilcategories_id = categoryId;
  }

  if (groupId > 0) {
    input.groups_id_assign = groupId;
  }

  const result = await glpiApiRequest('post', '/Ticket', { input });

  if (!result?.id) {
    console.error('GLPI Ticket create unexpected response:', result);
    throw new Error('GLPI ticket was not created');
  }

  return result.id;
}

export async function addGlpiTicketRequester(ticketId, glpiUserId) {
  // Важно: не глушим ошибку.
  // Если requester не добавился, заявка не считается корректно созданной от пользователя.
  await glpiApiRequest('post', '/Ticket_User', {
    input: {
      tickets_id: ticketId,
      users_id: glpiUserId,
      type: 1,
    },
  });
}

export async function addGlpiTicketFollowup(ticketId, content) {
  const result = await glpiApiRequest('post', '/ITILFollowup', {
    input: {
      itemtype: 'Ticket',
      items_id: ticketId,
      content,
      is_private: 0,
    },
  });

  return result?.id || null;
}

export async function getGlpiTicketFollowups(ticketId) {
  try {
    const result = await glpiApiRequest('get', `/Ticket/${ticketId}/ITILFollowup`);

    if (Array.isArray(result)) {
      return result;
    }

    return [];
  } catch (err) {
    console.error('getGlpiTicketFollowups error:', err.message);
    return [];
  }
}

export async function getGlpiTicketSolutions(ticketId) {
  try {
    const result = await glpiApiRequest('get', `/Ticket/${ticketId}/ITILSolution`);

    if (Array.isArray(result)) {
      return result;
    }

    return [];
  } catch (err) {
    console.error('getGlpiTicketSolutions error:', err.message);
    return [];
  }
}

export async function getLatestTicketSolutionText(ticketId) {
  const solutions = await getGlpiTicketSolutions(ticketId);

  for (const solution of [...solutions].reverse()) {
    const text = stripHtml(solution.content || solution.solution || solution.name || '');

    if (text) {
      return text;
    }
  }

  return '';
}

export async function getTicketDecision(ticketId) {
  const ticket = await getGlpiTicket(ticketId);
  const ticketStatus = Number(ticket.status || 0);

  const isFinalStatus =
    ticketStatus === GlpiTicketStatus.SOLVED ||
    ticketStatus === GlpiTicketStatus.CLOSED;

  if (!isFinalStatus) {
    return {
      isFinal: false,
      ticketStatus,
      decision: null,
    };
  }

  const solutions = await getGlpiTicketSolutions(ticketId);

  for (const solution of [...solutions].reverse()) {
    const decision = parseDecisionText(
      solution.content ||
      solution.solution ||
      solution.name ||
      ''
    );

    if (decision) {
      return {
        isFinal: true,
        ticketStatus,
        decision,
      };
    }
  }

  const followups = await getGlpiTicketFollowups(ticketId);

  for (const followup of [...followups].reverse()) {
    if (Number(followup.is_private || 0) === 1) {
      continue;
    }

    const decision = parseDecisionText(followup.content || '');

    if (decision) {
      return {
        isFinal: true,
        ticketStatus,
        decision,
      };
    }
  }

  const fallbackDecision = parseDecisionText(ticket.content || '');

  return {
    isFinal: true,
    ticketStatus,
    decision: fallbackDecision,
  };
}

export function buildUserTicketContent(maxUserId, glpiUserId, content) {
  return [
    'Заявка создана пользователем через MAX.',
    '',
    `MAX ID: ${maxUserId}`,
    `GLPI user ID: ${glpiUserId}`,
    '',
    'Описание:',
    content,
  ].join('\n');
}

export function buildRegistrationTicketContent(maxUserId, email, data) {
  return [
    'Пользователь не найден в SDS-helpdesk после проверки через LDAP/GLPI.',
    '',
    `Email: ${email}`,
    `MAX ID: ${maxUserId}`,
    '',
    `Организация: ${data.org || '-'}`,
    `Подразделение: ${data.dept || '-'}`,
    `ФИО: ${data.fio || '-'}`,
    `Должность: ${data.position || '-'}`,
    `Телефон: ${data.phone || '-'}`,
    '',
    'Содержание обращения:',
    data.issue || '-',
    '',
    'Действия администратора:',
    '1. Проверить данные пользователя.',
    '2. Добавить пользователя в SDS, если его нет.',
    '3. Добавить пользователя в группу helpdesk.',
    '4. Закрыть заявку с решением.',
    '',
    'При закрытии заявки в решении укажите обычным текстом:',
    '- "Подтвердить", если пользователь создан и доступ разрешен.',
    '- "Отказать", если доступ не разрешен. Укажите причину отказа.',
  ].join('\n');
}

export async function createGlpiRegistrationTicket(maxUserId, email, data) {
  const title = `Регистрация пользователя в SDS-helpdesk: ${data.fio || email}`;
  const content = buildRegistrationTicketContent(maxUserId, email, data);

  return await createGlpiTicket(title, content);
}

export async function createGlpiUserTicket(maxUserId, glpiUserId, content) {
  const title = truncateText(content, 80) || 'Заявка из MAX';
  const ticketContent = buildUserTicketContent(maxUserId, glpiUserId, content);

  const ticketId = await createGlpiTicket(title, ticketContent);

  await addGlpiTicketRequester(ticketId, glpiUserId);

  return {
    ticketId,
    title,
  };
}

export async function acceptGlpiTicketSolution(ticketId, maxUserId) {
  const content = [
    'Пользователь принял решение через MAX.',
    '',
    `MAX ID: ${maxUserId}`,
  ].join('\n');

  const followupId = await addGlpiTicketFollowup(ticketId, content);

  await updateGlpiTicket(ticketId, {
    status: GlpiTicketStatus.CLOSED,
  });

  return {
    followupId,
    content,
  };
}

export async function rejectGlpiTicketSolution(ticketId, reason) {
  const content = [
    'Пользователь отклонил решение через MAX.',
    '',
    'Причина:',
    reason,
  ].join('\n');

  const followupId = await addGlpiTicketFollowup(ticketId, content);

  await updateGlpiTicket(ticketId, {
    status: GlpiTicketStatus.PROCESSING,
  });

  return {
    followupId,
    content,
  };
}