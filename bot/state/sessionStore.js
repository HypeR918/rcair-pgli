const sessions = new Map();

export function getSession(maxUserId) {
  return sessions.get(maxUserId);
}

export function setSession(maxUserId, session) {
  sessions.set(maxUserId, session);
}

export function deleteSession(maxUserId) {
  sessions.delete(maxUserId);
}

export function clearSessions() {
  sessions.clear();
}

export { sessions };