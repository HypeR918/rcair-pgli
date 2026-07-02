import { pool } from '../services/dbService.js';

const cache = new Map();

function sanitizeForStorage(session) {
  if (!session) return null;

  const copy = { ...session };

  // не сохраняем открытый код, только его хэш
  delete copy.verificationCode;

  if (copy.ticketDraft) {
    copy.ticketDraft = { ...copy.ticketDraft };
    delete copy.ticketDraft.files;
  }

  return copy;
}

function hydrateFromStorage(row) {
  if (!row || !row.session_data) return null;

  const data = typeof row.session_data === 'string'
    ? JSON.parse(row.session_data)
    : row.session_data;

  if (data.ticketDraft) {
    data.ticketDraft.files = [];
  }

  return data;
}

export function getSession(maxUserId) {
  return cache.get(maxUserId) || null;
}

export async function setSession(maxUserId, session) {
  cache.set(maxUserId, session);

  const safe = sanitizeForStorage(session);

  if (!safe) {
    await pool.execute('DELETE FROM bot_sessions WHERE max_id = ?', [maxUserId]);
    return;
  }

  const json = JSON.stringify(safe);

  await pool.execute(
    'INSERT INTO bot_sessions (max_id, session_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE session_data = VALUES(session_data)',
    [maxUserId, json]
  );
}

export async function deleteSession(maxUserId) {
  cache.delete(maxUserId);
  await pool.execute('DELETE FROM bot_sessions WHERE max_id = ?', [maxUserId]);
}

export async function loadAllSessions() {
  const [rows] = await pool.execute('SELECT max_id, session_data FROM bot_sessions');

  for (const row of rows) {
    const session = hydrateFromStorage(row);
    if (session) {
      cache.set(row.max_id, session);
    }
  }

  console.log(`Loaded ${cache.size} sessions from database.`);
}

export function clearSessions() {
  cache.clear();
}

export { cache as sessions };
