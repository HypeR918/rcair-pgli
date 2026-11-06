const STATES = ['pending', 'processing', 'done', 'failed', 'uncertain'];
const safeCode = value => /^[A-Z0-9_.-]{1,64}$/.test(value || '') ? value : 'EVENT_HANDLER_FAILED';

export function createEventStore(pool, { codec, leaseMs = 60000, republishMs = 30000, retryBaseMs = 1000 } = {}) {
  const inserts = new Map();
  async function transaction(action) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await action(connection);
      await connection.commit();
      return value;
    } catch (error) {
      try { await connection.rollback(); } catch {}
      throw error;
    } finally { connection.release(); }
  }
  async function cas(sql, params) {
    const [result] = await pool.execute(sql, params);
    return result.affectedRows === 1;
  }
  return {
    async ensureSchema() {
      // DB-side gate общий для ingress и producer решений SDS в worker.
      await pool.execute(`CREATE TABLE IF NOT EXISTS bot_max_event_streams (
        user_key BINARY(32) NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB`);
      await pool.execute(`CREATE TABLE IF NOT EXISTS bot_max_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_key BINARY(32) NOT NULL UNIQUE,
        user_key BINARY(32) NOT NULL,
        update_type VARCHAR(32) NOT NULL,
        payload MEDIUMBLOB NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        lease_owner VARCHAR(64) NULL,
        lease_until DATETIME(6) NULL,
        handler_started_at DATETIME(6) NULL,
        published_at DATETIME(6) NULL,
        retry_safe BOOLEAN NOT NULL DEFAULT FALSE,
        next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        last_error_code VARCHAR(64) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        INDEX idx_dispatch (state, published_at, id),
        INDEX idx_user_order (user_key, id, state)
      ) ENGINE=InnoDB`);
    },
    async accept(update) {
      const identity = codec.identify(update);
      const key = identity.userKey.toString('hex');
      // Локальный gate уменьшает contention; общий порядок задаёт строка в InnoDB.
      const previous = inserts.get(key) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      inserts.set(key, current);
      await previous;
      try {
        try {
          return await transaction(async connection => {
            await connection.execute(`INSERT INTO bot_max_event_streams (user_key) VALUES (?)
              ON DUPLICATE KEY UPDATE user_key = VALUES(user_key)`, [identity.userKey]);
            const [result] = await connection.execute(
              'INSERT INTO bot_max_events (event_key, user_key, update_type, payload, retry_safe) VALUES (?, ?, ?, ?, ?)',
              [identity.eventKey, identity.userKey, identity.type, codec.encode(update, identity.eventKey),
                update.update_type === 'bot_started' || (update.update_type === 'message_created'
                  && /^\/(start|menu)$/.test(String(update.message?.body?.text || '').trim()))]
            );
            return { id: String(result.insertId), duplicate: false };
          });
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
          const [rows] = await pool.execute('SELECT id FROM bot_max_events WHERE event_key = ?', [identity.eventKey]);
          if (!rows.length) throw error;
          return { id: String(rows[0].id), duplicate: true };
        }
      } catch {
        const error = new Error('Хранилище событий недоступно'); error.code = 'EVENT_STORE_UNAVAILABLE'; error.status = 503; throw error;
      } finally {
        release();
        if (inserts.get(key) === current) inserts.delete(key);
      }
    },
    async publishable(limit = 50) {
      const [rows] = await pool.execute(`SELECT e.id, e.attempts FROM bot_max_events e
        WHERE e.state = 'pending'
          AND e.next_attempt_at <= NOW(6)
          AND (e.published_at IS NULL OR e.published_at < DATE_SUB(NOW(6), INTERVAL ? MICROSECOND))
          AND NOT EXISTS (SELECT 1 FROM bot_max_events p
            WHERE p.user_key = e.user_key AND p.id < e.id AND p.state <> 'done')
        ORDER BY e.id LIMIT ?`, [republishMs * 1000, Math.min(100, Math.max(1, limit))]);
      return rows.map(row => ({ id: String(row.id), attempts: Number(row.attempts) }));
    },
    async markPublished(id, attempts = 0) {
      await pool.execute("UPDATE bot_max_events SET published_at = NOW(6) WHERE id = ? AND state = 'pending' AND attempts = ?", [id, attempts]);
    },
    async claim(id, owner) {
      return transaction(async connection => {
        const [rows] = await connection.execute('SELECT * FROM bot_max_events WHERE id = ? FOR UPDATE', [id]);
        const row = rows[0];
        if (!row || row.state !== 'pending') return null;
        const [due] = await connection.execute('SELECT id FROM bot_max_events WHERE id = ? AND next_attempt_at <= NOW(6)', [id]);
        if (!due.length) return null;
        const [earlier] = await connection.execute(
          "SELECT id FROM bot_max_events WHERE user_key = ? AND id < ? AND state <> 'done' LIMIT 1", [row.user_key, id]);
        if (earlier.length) return null;
        let update;
        try { update = codec.decode(row.payload, row.event_key); }
        catch {
          await connection.execute("UPDATE bot_max_events SET state = 'failed', last_error_code = 'EVENT_PAYLOAD_INVALID' WHERE id = ?", [id]);
          return { id: String(row.id), invalid: true };
        }
        await connection.execute(`UPDATE bot_max_events SET state = 'processing', lease_owner = ?,
          lease_until = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND), handler_started_at = NULL,
          attempts = attempts + 1 WHERE id = ?`, [owner, leaseMs * 1000, id]);
        return { id: String(row.id), update, retrySafe: Boolean(row.retry_safe) };
      });
    },
    markStarted(id, owner) {
      return cas(`UPDATE bot_max_events SET handler_started_at = NOW(6)
        WHERE id = ? AND state = 'processing' AND lease_owner = ?
          AND lease_until > NOW(6) AND handler_started_at IS NULL`, [id, owner]);
    },
    renewLease(id, owner) {
      return cas(`UPDATE bot_max_events SET lease_until = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
        WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6)`, [leaseMs * 1000, id, owner]);
    },
    complete(id, owner) {
      return cas(`UPDATE bot_max_events SET state = 'done', payload = NULL, completed_at = NOW(6),
        lease_owner = NULL, lease_until = NULL, last_error_code = NULL
        WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6)`, [id, owner]);
    },
    fail(id, owner, code, state = 'failed') {
      if (!['failed', 'uncertain'].includes(state)) throw new Error('Недопустимое состояние события');
      return cas(`UPDATE bot_max_events SET state = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND state = 'processing' AND lease_owner = ?`, [state, safeCode(code), id, owner]);
    },
    async retrySafe(id, owner, code) {
      return transaction(async connection => {
        const [rows] = await connection.execute(`SELECT attempts FROM bot_max_events
          WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6) AND retry_safe = TRUE FOR UPDATE`, [id, owner]);
        if (!rows.length) return 'uncertain';
        const state = rows[0].attempts < 5 ? 'pending' : 'failed';
        const delay = Math.min(30000, retryBaseMs * (2 ** Math.min(rows[0].attempts - 1, 10)));
        await connection.execute(`UPDATE bot_max_events SET state = ?, lease_owner = NULL, lease_until = NULL,
          handler_started_at = NULL, published_at = NULL, last_error_code = ?,
          next_attempt_at = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND) WHERE id = ?`, [state, safeCode(code), delay * 1000, id]);
        return state;
      });
    },
    async recoverExpired() {
      await pool.execute(`UPDATE bot_max_events SET state = 'uncertain', last_error_code = 'WORKER_INTERRUPTED',
        lease_owner = NULL, lease_until = NULL
        WHERE state = 'processing' AND lease_until <= NOW(6) AND handler_started_at IS NOT NULL`);
      await pool.execute(`UPDATE bot_max_events SET state = 'pending', published_at = NULL,
        lease_owner = NULL, lease_until = NULL
        WHERE state = 'processing' AND lease_until <= NOW(6) AND handler_started_at IS NULL`);
    },
    async hasOutstandingForUser(user) {
      const [rows] = await pool.execute("SELECT 1 FROM bot_max_events WHERE user_key = ? AND state <> 'done' LIMIT 1", [codec.userKey(user)]);
      return rows.length > 0;
    },
    async stats() {
      const [rows] = await pool.execute('SELECT state, COUNT(*) AS amount FROM bot_max_events GROUP BY state');
      const states = Object.fromEntries(STATES.map(state => [state, 0]));
      for (const row of rows) states[row.state] = Number(row.amount);
      const [age] = await pool.execute(`SELECT COALESCE(MAX(TIMESTAMPDIFF(MICROSECOND, created_at, NOW(6))) / 1000, 0) AS oldest_ms,
        COUNT(DISTINCT CASE WHEN state IN ('failed', 'uncertain') THEN user_key END) AS blocked_users
        FROM bot_max_events WHERE state <> 'done'`);
      return { states, outstanding: Object.entries(states).filter(([state]) => state !== 'done').reduce((n, [, count]) => n + count, 0),
        oldest_pending_ms: Number(age[0].oldest_ms), blocked_users: Number(age[0].blocked_users) };
    },
    async assertDrained() {
      // Locking read ждёт незавершённые INSERT/COMMIT после остановки writers.
      return transaction(async connection => {
        const [rows] = await connection.execute("SELECT id FROM bot_max_events WHERE state <> 'done' FOR UPDATE");
        return rows.length === 0;
      });
    },
    async problems(limit = 20) {
      const [rows] = await pool.execute(`SELECT id, update_type, state, attempts, last_error_code, created_at
        FROM bot_max_events WHERE state IN ('failed', 'uncertain') ORDER BY id LIMIT ?`, [Math.min(100, Math.max(1, limit))]);
      return rows.map(row => ({ ...row, id: String(row.id) }));
    },
    async recent(limit = 20) {
      const [rows] = await pool.execute(`SELECT id, update_type, state, attempts, last_error_code, created_at, completed_at
        FROM bot_max_events ORDER BY id DESC LIMIT ?`, [Math.min(100, Math.max(1, limit))]);
      return rows.map(row => ({ ...row, id: String(row.id) }));
    },
    async resolveProblem(id, action) {
      if (!['skip', 'retry'].includes(action)) throw new Error('Действия: skip или retry');
      const sql = action === 'skip'
        ? "state = 'done', payload = NULL, completed_at = NOW(6)"
        : "state = 'pending', handler_started_at = NULL, published_at = NULL, next_attempt_at = NOW(6)";
      return cas(`UPDATE bot_max_events SET ${sql}, last_error_code = NULL
        WHERE id = ? AND state IN ('failed', 'uncertain')`, [id]);
    },
  };
}
