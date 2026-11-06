import { createHash } from 'node:crypto';
import { createDbPool } from '../services/dbPool.js';
import { createEventCodec } from './eventCodec.js';
import { createEventStore } from './eventStore.js';
import { createBroadcastStore } from '../broadcast/store.js';

export function createQueueResources(values, config) {
  const database = values.BOT_DB_NAME || values.DB_NAME;
  const pool = createDbPool({
    host: values.BOT_DB_HOST || values.DB_HOST,
    port: Number(values.BOT_DB_PORT || values.DB_PORT || 3306),
    user: values.BOT_DB_USER || values.DB_USER,
    password: values.BOT_DB_PASSWORD || values.DB_PASSWORD,
    database, connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true,
  }, { name: 'events', queryTimeoutMs: 5000, acquireTimeoutMs: 3000 });
  const codec = createEventCodec(config.secret);
  const store = createEventStore(pool, { codec });
  const broadcasts = createBroadcastStore(pool, codec);
  async function acquireWorkerLock(onLost) {
    const name = `max-worker:${createHash('sha256').update(database).digest('hex').slice(0, 32)}`;
    const connection = await pool.getConnection();
    let timer;
    try {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [name]);
      if (rows[0].acquired !== 1) throw new Error('Worker уже запущен для этой базы');
      let checking = false;
      timer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const [current] = await connection.execute('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [name]);
          if (current[0].owned !== 1) throw new Error();
        } catch { clearInterval(timer); onLost(); }
        finally { checking = false; }
      }, 5000);
      timer.unref();
      return async () => {
        clearInterval(timer);
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [name]); } catch {}
        connection.release();
      };
    } catch (error) { clearInterval(timer); connection.release(); throw error; }
  }
  return { store, broadcasts, pool, acquireWorkerLock };
}
