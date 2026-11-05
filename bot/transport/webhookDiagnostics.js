import { randomUUID } from 'node:crypto';
import { MAX_UPDATE_TYPES } from './config.js';

export function createWebhookDiagnostics(logger) {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  const active = new Map();
  const counts = { received: 0, authorized: 0, processed: 0, duplicate: 0, ignored: 0, rejected: 0, failed: 0 };
  const types = Object.fromEntries([...MAX_UPDATE_TYPES, 'unsupported'].map(type => [type, 0]));
  const replies = { attempted: 0, confirmed: 0, failed: 0 };
  const recent = [];
  let lastReceived = null;
  let lastCompleted = null;
  const log = data => logger.log('[MAX_WEBHOOK]', JSON.stringify(data));
  return {
    begin() {
      const event = ++counts.received;
      const now = Date.now();
      active.set(event, {
        startedAt: now, phase: 'http.authorization', phaseStartedAt: now,
        replies: { attempted: 0, confirmed: 0, failed: 0 },
      });
      lastReceived = new Date(now).toISOString();
      log({ event, stage: 'request' });
      return event;
    },
    authorize() { counts.authorized++; },
    setPhase(event, phase) {
      const entry = active.get(event);
      if (entry && entry.phase !== phase) {
        entry.phase = phase;
        entry.phaseStartedAt = Date.now();
      }
    },
    received(event, metadata) {
      types[metadata.type]++;
      active.get(event).metadata = metadata;
      log({ event, stage: 'received', ...metadata });
    },
    reply(event, result) {
      const entry = active.get(event);
      if (!entry) return;
      entry.replies[result]++;
      replies[result]++;
      log({ event, stage: 'reply', result });
    },
    finish(event, { status, result, reason, phase }) {
      const now = Date.now();
      const entry = active.get(event);
      const duration_ms = now - entry.startedAt;
      active.delete(event);
      lastCompleted = new Date(now).toISOString();
      const stage = reason ? 'rejected' : status >= 400 ? 'failed' : 'finished';
      if (stage === 'rejected') counts.rejected++;
      else if (stage === 'failed') counts.failed++;
      else counts[result]++;
      const summary = {
        event, ...(entry.metadata && entry.metadata), status, ...(result && { result }),
        ...(stage === 'failed' && { phase: phase || entry.phase }), duration_ms,
        replies: { ...entry.replies },
      };
      if (MAX_UPDATE_TYPES.includes(entry.metadata?.type)) {
        recent.push({ ...summary, completed_at: lastCompleted });
        if (recent.length > 20) recent.shift();
      }
      log({ event, stage, status, ...(result && { result }), ...(reason && { reason }),
        ...(stage === 'failed' && { phase: phase || entry.phase }), duration_ms, replies: { ...entry.replies } });
    },
    snapshot() {
      const now = Date.now();
      let oldest;
      const phases = {};
      for (const entry of active.values()) {
        if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
        phases[entry.phase] = (phases[entry.phase] || 0) + 1;
      }
      return {
        ...counts, instance_id: instanceId, types: { ...types }, active: active.size,
        replies: { ...replies }, recent_events: recent.map(entry => ({ ...entry, replies: { ...entry.replies } })),
        oldest_active_ms: oldest ? now - oldest.startedAt : 0,
        oldest_phase: oldest?.phase ?? null, oldest_phase_ms: oldest ? now - oldest.phaseStartedAt : 0,
        active_phases: phases,
        uptime_ms: now - startedAt, last_received_at: lastReceived, last_completed_at: lastCompleted,
      };
    },
  };
}
