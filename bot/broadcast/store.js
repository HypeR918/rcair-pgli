import { timingSafeEqual } from 'node:crypto';

const states = ['pending', 'processing', 'done', 'failed', 'uncertain', 'skipped'];
const eligible = `u.max_id > 0 AND u.glpi_user_id > 0 AND COALESCE(u.is_blocked, 0) = 0
  AND NOT EXISTS (SELECT 1 FROM blocked_max_ids b WHERE b.max_id = u.max_id)`;
const safeCode = code => /^[A-Z0-9_.-]{1,64}$/.test(code || '') ? code : 'BROADCAST_SEND_FAILED';

export function createBroadcastStore(pool, codec) {
  async function transaction(action) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await action(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch {}
      throw error;
    } finally { connection.release(); }
  }
  async function cas(sql, args) {
    const [result] = await pool.execute(sql, args);
    return result.affectedRows === 1;
  }
  const store = {
    async ensureSchema() {
      await pool.execute(`CREATE TABLE IF NOT EXISTS bot_broadcast_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        request_key BINARY(32) NOT NULL UNIQUE,
        request_hash BINARY(32) NOT NULL,
        payload MEDIUMBLOB NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB`);
      await pool.execute(`CREATE TABLE IF NOT EXISTS bot_broadcast_deliveries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT UNSIGNED NOT NULL,
        max_id BIGINT NOT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        lease_owner VARCHAR(64) NULL,
        lease_until DATETIME(6) NULL,
        handler_started_at DATETIME(6) NULL,
        published_at DATETIME(6) NULL,
        next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        last_error_code VARCHAR(64) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uniq_broadcast_recipient (job_id, max_id),
        INDEX idx_broadcast_pending (state, published_at, id),
        INDEX idx_broadcast_job (job_id, state)
      ) ENGINE=InnoDB`);
    },
    async create(key, text) {
      const requestKey = codec.identify({ update_type: 'broadcast_key', key }).eventKey;
      const requestHash = codec.identify({ update_type: 'broadcast_text', text }).eventKey;
      return transaction(async connection => {
        let result;
        try {
          [result] = await connection.execute(`INSERT INTO bot_broadcast_jobs
            (request_key, request_hash, payload) VALUES (?, ?, ?)`,
          [requestKey, requestHash, codec.encode({ text }, requestKey)]);
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
          const [rows] = await connection.execute(
            'SELECT id, request_hash FROM bot_broadcast_jobs WHERE request_key = ? FOR UPDATE', [requestKey]);
          if (!rows.length || !timingSafeEqual(rows[0].request_hash, requestHash)) {
            const conflict = new Error('Ключ уже использован для другого текста');
            conflict.code = 'BROADCAST_KEY_CONFLICT'; conflict.status = 409; throw conflict;
          }
          return { id: String(rows[0].id), created: false };
        }
        const id = String(result.insertId);
        await connection.execute(`INSERT INTO bot_broadcast_deliveries (job_id, max_id)
          SELECT ?, u.max_id FROM bot_users u WHERE ${eligible}`, [id]);
        return { id, created: true };
      });
    },
    async status(id) {
      const [jobs] = await pool.execute('SELECT id, created_at FROM bot_broadcast_jobs WHERE id = ?', [id]);
      if (!jobs.length) return null;
      const [rows] = await pool.execute('SELECT state, COUNT(*) AS amount FROM bot_broadcast_deliveries WHERE job_id = ? GROUP BY state', [id]);
      const counts = Object.fromEntries(states.map(state => [state, 0]));
      for (const row of rows) counts[row.state] = Number(row.amount);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const [problems] = await pool.execute(`SELECT id, state, attempts, last_error_code
        FROM bot_broadcast_deliveries WHERE job_id = ? AND state IN ('failed', 'uncertain') ORDER BY id LIMIT 20`, [id]);
      return { id: String(jobs[0].id), created_at: jobs[0].created_at, total, counts,
        status: counts.pending || counts.processing ? 'running'
          : counts.failed || counts.uncertain ? 'completed_with_errors' : 'completed',
        problems: problems.map(row => ({ ...row, id: String(row.id) })) };
    },
    async publishable(limit = 10) {
      const [rows] = await pool.execute(`SELECT id, attempts FROM bot_broadcast_deliveries
        WHERE state = 'pending' AND next_attempt_at <= NOW(6)
          AND (published_at IS NULL OR published_at < DATE_SUB(NOW(6), INTERVAL 30 SECOND))
        ORDER BY id LIMIT ?`, [Math.min(10, Math.max(1, limit))]);
      return rows.map(row => ({ id: String(row.id), attempts: Number(row.attempts) }));
    },
    markPublished(id, attempts = 0) {
      return cas(`UPDATE bot_broadcast_deliveries SET published_at = NOW(6)
        WHERE id = ? AND state = 'pending' AND attempts = ?`, [id, attempts]);
    },
    async claim(id, owner) {
      return transaction(async connection => {
        const [rows] = await connection.execute(`SELECT d.*, j.payload, j.request_key,
          TIMESTAMPDIFF(MICROSECOND, d.created_at, NOW(6)) / 1000 AS queue_wait_ms
          FROM bot_broadcast_deliveries d JOIN bot_broadcast_jobs j ON j.id = d.job_id
          WHERE d.id = ? FOR UPDATE`, [id]);
        const row = rows[0];
        if (!row || row.state !== 'pending') return null;
        const [due] = await connection.execute('SELECT 1 FROM bot_broadcast_deliveries WHERE id = ? AND next_attempt_at <= NOW(6)', [id]);
        if (!due.length) return null;
        const [users] = await connection.execute(`SELECT 1 FROM bot_users u WHERE u.max_id = ? AND ${eligible}`, [row.max_id]);
        if (!users.length) {
          await connection.execute("UPDATE bot_broadcast_deliveries SET state = 'skipped', completed_at = NOW(6) WHERE id = ?", [id]);
          return null;
        }
        let payload;
        try { payload = codec.decode(row.payload, row.request_key); }
        catch {
          await connection.execute("UPDATE bot_broadcast_deliveries SET state = 'failed', last_error_code = 'EVENT_PAYLOAD_INVALID' WHERE id = ?", [id]);
          return { invalid: true };
        }
        await connection.execute(`UPDATE bot_broadcast_deliveries SET state = 'processing',
          attempts = attempts + 1, lease_owner = ?, lease_until = DATE_ADD(NOW(6), INTERVAL 60 SECOND),
          handler_started_at = NULL WHERE id = ?`, [owner, id]);
        return { id: String(row.id), retrySafe: true, queueWaitMs: Math.max(0, Math.round(Number(row.queue_wait_ms))),
          update: { update_type: 'broadcast_message', user: { user_id: String(row.max_id) },
            job_id: String(row.job_id), text: payload.text } };
      });
    },
    markStarted(id, owner) {
      return cas(`UPDATE bot_broadcast_deliveries SET handler_started_at = NOW(6)
        WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6)
          AND handler_started_at IS NULL`, [id, owner]);
    },
    renewLease(id, owner) {
      return cas(`UPDATE bot_broadcast_deliveries SET lease_until = DATE_ADD(NOW(6), INTERVAL 60 SECOND)
        WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6)`, [id, owner]);
    },
    complete(id, owner) {
      return cas(`UPDATE bot_broadcast_deliveries SET state = 'done', completed_at = NOW(6),
        lease_owner = NULL, lease_until = NULL, last_error_code = NULL
        WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6)`, [id, owner]);
    },
    fail(id, owner, code, state = 'failed') {
      if (!['failed', 'uncertain'].includes(state)) throw new Error('Недопустимое состояние рассылки');
      return cas(`UPDATE bot_broadcast_deliveries SET state = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND state = 'processing' AND lease_owner = ?`, [state, safeCode(code), id, owner]);
    },
    retrySafe(id, owner, code) {
      return transaction(async connection => {
        const [rows] = await connection.execute(`SELECT attempts FROM bot_broadcast_deliveries
          WHERE id = ? AND state = 'processing' AND lease_owner = ? AND lease_until > NOW(6) FOR UPDATE`, [id, owner]);
        if (!rows.length) return 'uncertain';
        const pending = code === 'BROADCAST_RATE_LIMIT' && rows[0].attempts < 5;
        const state = pending ? 'pending' : 'failed';
        const delay = Math.min(60000, 5000 * 2 ** Math.min(rows[0].attempts - 1, 4));
        await connection.execute(`UPDATE bot_broadcast_deliveries SET state = ?, last_error_code = ?,
          lease_owner = NULL, lease_until = NULL, handler_started_at = NULL, published_at = NULL,
          next_attempt_at = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND) WHERE id = ?`, [state, safeCode(code), delay * 1000, id]);
        return state;
      });
    },
    async recoverExpired() {
      await pool.execute(`UPDATE bot_broadcast_deliveries SET state = 'uncertain',
        last_error_code = 'WORKER_INTERRUPTED', lease_owner = NULL, lease_until = NULL
        WHERE state = 'processing' AND lease_until <= NOW(6) AND handler_started_at IS NOT NULL`);
      await pool.execute(`UPDATE bot_broadcast_deliveries SET state = 'pending', published_at = NULL,
        lease_owner = NULL, lease_until = NULL WHERE state = 'processing'
          AND lease_until <= NOW(6) AND handler_started_at IS NULL`);
      await pool.execute(`UPDATE bot_broadcast_jobs j SET payload = NULL WHERE payload IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bot_broadcast_deliveries d
          WHERE d.job_id = j.id AND d.state NOT IN ('done', 'skipped'))`);
    },
    async assertDrained() {
      return transaction(async connection => {
        const [rows] = await connection.execute("SELECT id FROM bot_broadcast_deliveries WHERE state NOT IN ('done', 'skipped') FOR UPDATE");
        return rows.length === 0;
      });
    },
    async stats() {
      const [rows] = await pool.execute('SELECT state, COUNT(*) AS amount FROM bot_broadcast_deliveries GROUP BY state');
      const counts = Object.fromEntries(states.map(state => [state, 0]));
      for (const row of rows) counts[row.state] = Number(row.amount);
      return { states: counts, outstanding: counts.pending + counts.processing + counts.failed + counts.uncertain };
    },
    resolveProblem(id, action) {
      if (!['skip', 'retry'].includes(action)) throw new Error('Действия: skip или retry');
      return cas(`UPDATE bot_broadcast_deliveries SET ${action === 'skip'
        ? "state = 'skipped', completed_at = NOW(6)"
        : "state = 'pending', handler_started_at = NULL, published_at = NULL, next_attempt_at = NOW(6)"},
        last_error_code = NULL WHERE id = ? AND state IN ('failed', 'uncertain')`, [id]);
    },
  };
  return store;
}
