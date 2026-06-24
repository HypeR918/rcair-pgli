import fs from 'node:fs';
import FormData from 'form-data';
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

function hasFileExtension(filename) {
  return /\.[a-z0-9]{2,10}$/i.test(String(filename || ''));
}

function appendExtensionIfMissing(filename, extension) {
  const safeFilename = String(filename || '').trim() || `attachment-${Date.now()}`;

  if (hasFileExtension(safeFilename)) {
    return safeFilename;
  }

  return `${safeFilename}.${extension}`;
}

function detectMimeAndExtensionByMagic(filePath, currentMimeType, currentFilename) {
  const buffer = fs.readFileSync(filePath);

  const b0 = buffer[0];
  const b1 = buffer[1];
  const b2 = buffer[2];
  const b3 = buffer[3];

  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    return {
      mimeType: 'image/jpeg',
      filename: appendExtensionIfMissing(currentFilename, 'jpg'),
    };
  }

  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) {
    return {
      mimeType: 'image/png',
      filename: appendExtensionIfMissing(currentFilename, 'png'),
    };
  }

  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) {
    return {
      mimeType: 'image/gif',
      filename: appendExtensionIfMissing(currentFilename, 'gif'),
    };
  }

  if (
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return {
      mimeType: 'image/webp',
      filename: appendExtensionIfMissing(currentFilename, 'webp'),
    };
  }

  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    return {
      mimeType: 'application/pdf',
      filename: appendExtensionIfMissing(currentFilename, 'pdf'),
    };
  }

  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) {
    return {
      mimeType: currentMimeType && currentMimeType !== 'application/octet-stream'
        ? currentMimeType
        : 'application/zip',
      filename: hasFileExtension(currentFilename)
        ? currentFilename
        : `${currentFilename}.zip`,
    };
  }

  return {
    mimeType: currentMimeType || 'application/octet-stream',
    filename: currentFilename,
  };
}

function extractEntityIdFromTicket(ticket) {
  const raw = ticket?.entities_id;

  if (raw === null || raw === undefined || raw === '') {
    return 0;
  }

  if (typeof raw === 'object') {
    return Number(raw.id || raw.value || 0);
  }

  return Number(raw || 0);
}

function extractEntityNameFromTicket(ticket) {
  if (!ticket) {
    return '';
  }

  if (typeof ticket.entities_id === 'object') {
    return (
      ticket.entities_id.completename ||
      ticket.entities_id.name ||
      ticket.entities_id.label ||
      ''
    );
  }

  return (
    ticket.entities_name ||
    ticket.entity_name ||
    ticket.entityName ||
    ''
  );
}

function normalizeEntityId(entityId) {
  const normalized = Number(entityId);

  if (Number.isFinite(normalized) && normalized >= 0) {
    return normalized;
  }

  const fallback = Number(env.GLPI_ENTITY_ID || 0);

  if (Number.isFinite(fallback) && fallback >= 0) {
    return fallback;
  }

  return 0;
}

function normalizePositiveEntityId(entityId) {
  const normalized = Number(entityId);

  if (Number.isFinite(normalized) && normalized > 0) {
    return normalized;
  }

  return 0;
}

function extractId(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  if (typeof value === 'object') {
    return Number(value.id || value.value || 0);
  }

  return Number(value || 0);
}

function extractEntityIdFromAnyValue(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  if (typeof value === 'object') {
    return normalizePositiveEntityId(
      value.id ||
      value.value ||
      value.entities_id ||
      value.entity_id ||
      0
    );
  }

  return normalizePositiveEntityId(value);
}

function isDuplicateRequesterError(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    message.includes('duplicate') ||
    message.includes('already') ||
    message.includes('существ') ||
    message.includes('дубликат')
  );
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

    if (data !== null && data !== undefined && lowerMethod !== 'get') {
      config.data = data;
    }

    const res = await axios(config);

    if (res.status < 200 || res.status >= 300) {
      console.error('GLPI API request failed:', method, finalPath, res.status, res.data);
      throw new Error(
        `GLPI API request failed: ${res.status} ${JSON.stringify(res.data)}`
      );
    }

    return res.data;
  } finally {
    await glpiKillSession(sessionToken);
  }
}

export async function glpiMultipartRequest(method, path, form) {
  const sessionToken = await glpiInitSession();

  try {
    const baseUrl = getGlpiApiBaseUrl();
    const lowerMethod = method.toLowerCase();

    const needsWriteSession = ['post', 'put', 'patch', 'delete'].includes(lowerMethod);
    const separator = path.includes('?') ? '&' : '?';
    const finalPath = needsWriteSession
      ? `${path}${separator}session_write=true`
      : path;

    const formHeaders = form.getHeaders();

    const headers = {
      ...formHeaders,
      'Session-Token': sessionToken,
    };

    if (env.GLPI_API_APP_TOKEN) {
      headers['App-Token'] = env.GLPI_API_APP_TOKEN;
    }

    let contentLength = null;

    try {
      contentLength = await new Promise((resolve, reject) => {
        form.getLength((error, length) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(length);
        });
      });
    } catch (error) {
      console.warn('GLPI multipart Content-Length was not calculated:', error.message);
    }

    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    const res = await axios({
      method,
      url: `${baseUrl}${finalPath}`,
      headers,
      data: form,
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      console.error('GLPI multipart request failed:', method, finalPath, res.status, res.data);
      throw new Error(
        `GLPI multipart request failed: ${res.status} ${JSON.stringify(res.data)}`
      );
    }

    return res.data;
  } finally {
    await glpiKillSession(sessionToken);
  }
}

async function getGlpiUserEntityIdFromUser(glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return 0;
  }

  try {
    const user = await glpiApiRequest('get', `/User/${requesterId}`);

    const entityId = extractEntityIdFromAnyValue(
      user.entities_id ||
      user.entity_id ||
      user.default_entity ||
      user.default_entities_id
    );

    if (entityId > 0) {
      console.log('=== GLPI REQUESTER ENTITY FROM USER ===');
      console.log('requesterId:', requesterId);
      console.log('entityId:', entityId);
      return entityId;
    }
  } catch (error) {
    console.warn('getGlpiUserEntityIdFromUser warning:', error.message);
  }

  return 0;
}

async function getGlpiUserEntityIdFromProfiles(glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return 0;
  }

  try {
    const profiles = await glpiApiRequest('get', `/User/${requesterId}/Profile_User`);

    if (!Array.isArray(profiles)) {
      return 0;
    }

    const normalizedProfiles = profiles
      .map(profile => ({
        entityId: extractEntityIdFromAnyValue(profile.entities_id || profile.entity_id),
        isDefault: Number(profile.is_default || profile.is_default_profile || 0),
        isRecursive: Number(profile.is_recursive || 0),
      }))
      .filter(profile => profile.entityId > 0);

    if (normalizedProfiles.length === 0) {
      return 0;
    }

    const defaultProfile = normalizedProfiles.find(profile => profile.isDefault === 1);
    const selectedProfile = defaultProfile || normalizedProfiles[0];

    console.log('=== GLPI REQUESTER ENTITY FROM PROFILE_USER ===');
    console.log('requesterId:', requesterId);
    console.log('entityId:', selectedProfile.entityId);
    console.log('isDefault:', selectedProfile.isDefault);
    console.log('isRecursive:', selectedProfile.isRecursive);

    return selectedProfile.entityId;
  } catch (error) {
    console.warn('getGlpiUserEntityIdFromProfiles warning:', error.message);
  }

  return 0;
}

async function resolveRequesterEntityId(glpiUserId, preferredEntityId = null) {
  const preferred = normalizePositiveEntityId(preferredEntityId);

  if (preferred > 0) {
    console.log('=== GLPI REQUESTER ENTITY FROM LOCAL DB ===');
    console.log('requesterId:', glpiUserId);
    console.log('entityId:', preferred);
    return preferred;
  }

  const fromUser = await getGlpiUserEntityIdFromUser(glpiUserId);

  if (fromUser > 0) {
    return fromUser;
  }

  const fromProfiles = await getGlpiUserEntityIdFromProfiles(glpiUserId);

  if (fromProfiles > 0) {
    return fromProfiles;
  }

  const fallback = normalizeEntityId(env.GLPI_ENTITY_ID);

  console.warn('=== GLPI REQUESTER ENTITY FALLBACK USED ===');
  console.warn('requesterId:', glpiUserId);
  console.warn('fallbackEntityId:', fallback);

  return fallback;
}

export async function uploadGlpiDocument(file, entityId = null) {
  if (!file?.path) {
    throw new Error('Attachment file path is empty');
  }

  if (!fs.existsSync(file.path)) {
    throw new Error(`Attachment file does not exist: ${file.path}`);
  }

  const stat = fs.statSync(file.path);

  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Attachment file is empty or invalid: ${file.path}`);
  }

  const originalFilename = String(file.filename || '').trim() || `attachment-${Date.now()}`;
  const originalMimeType = String(file.mimeType || '').trim() || 'application/octet-stream';

  const detected = detectMimeAndExtensionByMagic(
    file.path,
    originalMimeType,
    originalFilename
  );

  const filename = detected.filename;
  const mimeType = detected.mimeType;
  const normalizedEntityId = normalizeEntityId(entityId);

  console.log('=== GLPI DOCUMENT UPLOAD START ===');
  console.log('localPath:', file.path);
  console.log('filename:', filename);
  console.log('mimeType:', mimeType);
  console.log('size:', stat.size);
  console.log('documentEntityId:', normalizedEntityId);

  const form = new FormData();

  const uploadManifest = {
    input: {
      name: filename,
      _filename: [filename],
      entities_id: normalizedEntityId,
      is_recursive: 0,
    },
  };

  form.append('uploadManifest', JSON.stringify(uploadManifest));

  form.append('filename[0]', fs.createReadStream(file.path), {
    filename,
    contentType: mimeType,
    knownLength: stat.size,
  });

  const result = await glpiMultipartRequest('post', '/Document', form);

  console.log('=== GLPI DOCUMENT UPLOAD RESULT FULL ===');
  console.log(JSON.stringify(result, null, 2));

  if (!result?.id) {
    console.error('GLPI document upload unexpected response:', result);
    throw new Error('GLPI document was not uploaded');
  }

  const uploadInfo = result?.upload_result?.filename?.[0];

  if (uploadInfo) {
    console.log('=== GLPI DOCUMENT UPLOAD FILE RESULT ===');
    console.log(JSON.stringify(uploadInfo, null, 2));

    if (uploadInfo.error) {
      throw new Error(`GLPI file upload error: ${JSON.stringify(uploadInfo)}`);
    }
  }

  console.log('=== GLPI DOCUMENT UPLOADED ===');
  console.log('documentId:', result.id);
  console.log('filename:', filename);
  console.log('documentEntityId:', normalizedEntityId);

  return {
    documentId: result.id,
    filename,
    entityId: normalizedEntityId,
  };
}

export async function attachGlpiDocumentToTicket(ticketId, documentId) {
  return await glpiApiRequest('post', '/Document_Item', {
    input: {
      documents_id: documentId,
      itemtype: 'Ticket',
      items_id: ticketId,
    },
  });
}

export async function uploadAndAttachFilesToTicket(ticketId, files) {
  const uploaded = [];

  if (!Array.isArray(files) || files.length === 0) {
    return uploaded;
  }

  const ticket = await getGlpiTicket(ticketId);
  const ticketEntityId = normalizeEntityId(ticket.entityId);

  console.log('=== GLPI ATTACH FILES TO TICKET ===');
  console.log('ticketId:', ticketId);
  console.log('ticketEntityId:', ticketEntityId);
  console.log('filesCount:', files.length);

  for (const file of files) {
    const { documentId, filename, entityId } = await uploadGlpiDocument(file, ticketEntityId);

    console.log('=== GLPI DOCUMENT ITEM LINK START ===');
    console.log('ticketId:', ticketId);
    console.log('ticketEntityId:', ticketEntityId);
    console.log('documentId:', documentId);
    console.log('documentEntityId:', entityId);

    await attachGlpiDocumentToTicket(ticketId, documentId);

    console.log('=== GLPI DOCUMENT ITEM LINKED ===');
    console.log('ticketId:', ticketId);
    console.log('documentId:', documentId);

    uploaded.push({
      documentId,
      filename,
      entityId,
    });
  }

  return uploaded;
}

export async function getGlpiTicket(ticketId) {
  const ticket = await glpiApiRequest('get', `/Ticket/${ticketId}`);

  const entityId = extractEntityIdFromTicket(ticket);
  const entityName = extractEntityNameFromTicket(ticket);

  return {
    ...ticket,
    entityId,
    entityName,
  };
}

export async function getGlpiEntityName(entityId) {
  const normalizedEntityId = Number(entityId || 0);

  if (!normalizedEntityId) {
    return 'Root';
  }

  try {
    const entity = await glpiApiRequest('get', `/Entity/${normalizedEntityId}`);

    return (
      entity.completename ||
      entity.name ||
      `Организация ID ${normalizedEntityId}`
    );
  } catch (err) {
    console.error('getGlpiEntityName error:', normalizedEntityId, err.message);
    return `Организация ID ${normalizedEntityId}`;
  }
}

export async function updateGlpiTicket(ticketId, input) {
  return await glpiApiRequest('put', `/Ticket/${ticketId}`, {
    input: {
      id: ticketId,
      ...input,
    },
  });
}

export async function ensureGlpiTicketEntity(ticketId, entityId) {
  const normalizedEntityId = normalizePositiveEntityId(entityId);

  if (!normalizedEntityId) {
    console.warn('=== GLPI TICKET ENTITY SKIP ===');
    console.warn('ticketId:', ticketId);
    console.warn('entityId:', entityId);
    return;
  }

  const ticketBefore = await getGlpiTicket(ticketId);
  const currentEntityId = normalizeEntityId(ticketBefore.entityId);

  console.log('=== GLPI ENSURE TICKET ENTITY START ===');
  console.log('ticketId:', ticketId);
  console.log('currentEntityId:', currentEntityId);
  console.log('targetEntityId:', normalizedEntityId);

  if (currentEntityId === normalizedEntityId) {
    console.log('=== GLPI TICKET ENTITY ALREADY OK ===');
    console.log('ticketId:', ticketId);
    console.log('entityId:', normalizedEntityId);
    return;
  }

  await updateGlpiTicket(ticketId, {
    entities_id: normalizedEntityId,
  });

  const ticketAfter = await getGlpiTicket(ticketId);
  const finalEntityId = normalizeEntityId(ticketAfter.entityId);

  console.log('=== GLPI ENSURE TICKET ENTITY RESULT ===');
  console.log('ticketId:', ticketId);
  console.log('targetEntityId:', normalizedEntityId);
  console.log('finalEntityId:', finalEntityId);

  if (finalEntityId !== normalizedEntityId) {
    throw new Error(
      `GLPI ticket entity was not changed. Ticket ${ticketId}, expected ${normalizedEntityId}, got ${finalEntityId}`
    );
  }
}

export async function getGlpiTicketUsers(ticketId) {
  try {
    const result = await glpiApiRequest('get', `/Ticket/${ticketId}/Ticket_User`);

    if (Array.isArray(result)) {
      return result;
    }

    return [];
  } catch (error) {
    console.warn('getGlpiTicketUsers warning:', error.message);
    return [];
  }
}

export async function hasGlpiTicketRequester(ticketId, glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return false;
  }

  const users = await getGlpiTicketUsers(ticketId);

  return users.some(item => {
    const userId = extractId(item.users_id);
    const type = Number(item.type || 0);

    return userId === requesterId && type === 1;
  });
}

export async function setGlpiTicketRequester(ticketId, glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return null;
  }

  return await updateGlpiTicket(ticketId, {
    _users_id_requester: requesterId,
  });
}

export async function addGlpiTicketRequester(ticketId, glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return null;
  }

  return await glpiApiRequest('post', '/Ticket_User', {
    input: {
      tickets_id: Number(ticketId),
      users_id: requesterId,
      type: 1,
      use_notification: 1,
    },
  });
}

export async function ensureGlpiTicketRequester(ticketId, glpiUserId) {
  const requesterId = Number(glpiUserId || 0);

  if (!requesterId) {
    return;
  }

  console.log('=== GLPI ENSURE REQUESTER START ===');
  console.log('ticketId:', ticketId);
  console.log('requesterId:', requesterId);

  const alreadyBefore = await hasGlpiTicketRequester(ticketId, requesterId);

  if (alreadyBefore) {
    console.log('=== GLPI REQUESTER ALREADY EXISTS ===');
    console.log('ticketId:', ticketId);
    console.log('requesterId:', requesterId);
    return;
  }

  await setGlpiTicketRequester(ticketId, requesterId);

  const alreadyAfterUpdate = await hasGlpiTicketRequester(ticketId, requesterId);

  if (alreadyAfterUpdate) {
    console.log('=== GLPI REQUESTER SET BY TICKET UPDATE ===');
    console.log('ticketId:', ticketId);
    console.log('requesterId:', requesterId);
    return;
  }

  try {
    await addGlpiTicketRequester(ticketId, requesterId);
  } catch (error) {
    if (isDuplicateRequesterError(error)) {
      console.log('=== GLPI REQUESTER DUPLICATE IGNORED ===');
      console.log('ticketId:', ticketId);
      console.log('requesterId:', requesterId);
      return;
    }

    throw error;
  }

  const alreadyAfterAdd = await hasGlpiTicketRequester(ticketId, requesterId);

  if (!alreadyAfterAdd) {
    throw new Error(`GLPI requester was not attached to ticket ${ticketId}`);
  }

  console.log('=== GLPI REQUESTER SET BY TICKET_USER ===');
  console.log('ticketId:', ticketId);
  console.log('requesterId:', requesterId);
}

export async function createGlpiTicket(title, content, options = {}) {
  const entityId = normalizeEntityId(
    options.entityId !== undefined
      ? options.entityId
      : env.GLPI_ENTITY_ID
  );

  const input = {
    name: title,
    content,
    entities_id: entityId,
    type: options.type ?? env.GLPI_DEFAULT_TICKET_TYPE,
    urgency: options.urgency ?? 3,
    impact: options.impact ?? 3,
    priority: options.priority ?? 3,
  };

  const requesterId = Number(options.requesterId || 0);

  if (requesterId > 0) {
    input._users_id_requester = requesterId;
  }

  const requestTypeId =
    options.requestTypeId !== undefined
      ? Number(options.requestTypeId)
      : env.GLPI_DEFAULT_REQUEST_TYPE_ID;

  if (requestTypeId > 0) {
    input.requesttypes_id = requestTypeId;
  }

  const categoryId =
    options.categoryId !== undefined
      ? Number(options.categoryId)
      : env.GLPI_DEFAULT_REQUEST_CATEGORY_ID;

  if (categoryId > 0) {
    input.itilcategories_id = categoryId;
  }

  const groupId =
    options.groupId !== undefined
      ? Number(options.groupId)
      : env.GLPI_DEFAULT_ASSIGN_GROUP_ID;

  if (groupId > 0) {
    input.groups_id_assign = groupId;
  }

  console.log('=== GLPI CREATE TICKET INPUT ===');
  console.log(JSON.stringify(input, null, 2));

  const result = await glpiApiRequest('post', '/Ticket', { input });

  if (!result?.id) {
    console.error('GLPI Ticket create unexpected response:', result);
    throw new Error('GLPI ticket was not created');
  }

  const ticketId = result.id;

  if (requesterId > 0) {
    await ensureGlpiTicketRequester(ticketId, requesterId);
  }

  return ticketId;
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

export function buildRegistrationTicketContent(maxUserId, email, data) {
  return [
    'Пользователь не найден в каталоге пользователей после проверки через LDAP/GLPI.',
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
  const title = `Регистрация пользователя: ${data.fio || email}`;
  const content = buildRegistrationTicketContent(maxUserId, email, data);

  return await createGlpiTicket(title, content, {
    type: env.GLPI_DEFAULT_TICKET_TYPE,
    requestTypeId: env.GLPI_DEFAULT_REQUEST_TYPE_ID,
  });
}

export function buildUserTicketContent(maxUserId, glpiUserId, description) {
  return description;
}

export async function createGlpiUserTicket(
  maxUserId,
  glpiUserId,
  title,
  description,
  options = {}
) {
  const ticketTitle = truncateText(title, 250) || 'Заявка из MAX';
  const ticketContent = buildUserTicketContent(maxUserId, glpiUserId, description);
  const requesterEntityId = await resolveRequesterEntityId(glpiUserId, options.entityId);

  console.log('=== GLPI CREATE USER TICKET CONTEXT ===');
  console.log('maxUserId:', maxUserId);
  console.log('glpiUserId:', glpiUserId);
  console.log('localEntityId:', options.entityId);
  console.log('resolvedRequesterEntityId:', requesterEntityId);

  const ticketId = await createGlpiTicket(ticketTitle, ticketContent, {
    requesterId: glpiUserId,
    entityId: requesterEntityId,
    type: options.type ?? env.GLPI_DEFAULT_TICKET_TYPE,
    requestTypeId: options.requestTypeId ?? env.GLPI_DEFAULT_REQUEST_TYPE_ID,
    categoryId: options.categoryId ?? env.GLPI_DEFAULT_REQUEST_CATEGORY_ID,
    groupId: options.groupId ?? env.GLPI_DEFAULT_ASSIGN_GROUP_ID,
  });

  await ensureGlpiTicketEntity(ticketId, requesterEntityId);
  await ensureGlpiTicketRequester(ticketId, glpiUserId);

  return {
    ticketId,
    title: ticketTitle,
  };
}

export async function getGlpiUserTickets(glpiUserId, options = {}) {
  const userId = Number(glpiUserId || 0);

  if (!userId) {
    return [];
  }

  const limit = options.limit || 20;

  try {
    const userTickets = await glpiApiRequest(
      'get',
      `/Ticket_User?criteria[0][table]=glpi_ticketusers&criteria[0][field]=users_id&criteria[0][searchtype]=equals&criteria[0][value]=${userId}&criteria[1][table]=glpi_ticketusers&criteria[1][field]=type&criteria[1][searchtype]=equals&criteria[1][value]=1&range=0-${limit - 1}`
    );

    if (!Array.isArray(userTickets) || userTickets.length === 0) {
      return [];
    }

    const ticketIds = userTickets.map(ut => Number(ut.tickets_id || ut.id || 0)).filter(id => id > 0);

    if (ticketIds.length === 0) {
      return [];
    }

    const tickets = [];

    for (const ticketId of ticketIds.slice(0, limit)) {
      try {
        const ticket = await getGlpiTicket(ticketId);
        const status = Number(ticket.status || 0);

        if (status === 6) {
          continue;
        }

        tickets.push({
          ticketId,
          name: ticket.name || '',
          status,
        });
      } catch (err) {
        if (!isGlpiTicketNotFoundError(err)) {
          console.warn('getGlpiUserTickets skip ticket:', ticketId, err.message);
        }
      }
    }

    return tickets;
  } catch (error) {
    console.error('getGlpiUserTickets error:', error.message);
    return [];
  }
}

export async function getGlpiUserTicketsAsRequester(glpiUserId, options = {}) {
  const userId = Number(glpiUserId || 0);
  if (!userId) return [];

  const limit = options.limit || 20;

  try {
    const { glpiPool } = await import('./dbService.js');

    const [rows] = await glpiPool.execute(
      `SELECT t.id, t.name, t.status
       FROM glpi_tickets t
       INNER JOIN glpi_tickets_users tu ON tu.tickets_id = t.id
       WHERE tu.users_id = ?
         AND tu.type = 1
         AND t.status != 6
       ORDER BY t.id DESC
       LIMIT ?`,
      [userId, limit]
    );

    return (rows || []).map(row => ({
      ticketId: Number(row.id || 0),
      name: row.name || '',
      status: Number(row.status || 0),
    })).filter(t => t.ticketId > 0);
  } catch (error) {
    console.warn('getGlpiUserTicketsAsRequester warning:', error.message);
    return [];
  }
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