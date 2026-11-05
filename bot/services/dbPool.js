import mysql from 'mysql2/promise';
import { withOperation } from '../utils/operationContext.js';

function dbError(code, name, operation) {
  const error = new Error(`БД ${name}: ${operation}`);
  error.code = code;
  return error;
}

export function createDbPool(config, { name = 'db', queryTimeoutMs = 10000, acquireTimeoutMs = 3000 } = {}) {
  for (const value of [queryTimeoutMs, acquireTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
      throw new Error('Таймаут БД должен быть положительным числом миллисекунд');
    }
  }
  const pool = mysql.createPool({
    queueLimit: 50, ...config,
    connectTimeout: Math.min(config.connectTimeout ?? 10000, acquireTimeoutMs),
  });

  function wrap(connection) {
    let closed = false;
    let released = false;
    const destroy = () => {
      if (!closed && !released) { closed = true; connection.destroy(); }
    };
    const run = (method, args) => withOperation(`db.${name}.${method}`, () => new Promise((resolve, reject) => {
      if (closed || released) {
        reject(dbError('DB_CONNECTION_CLOSED', name, 'соединение уже закрыто'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        // Соединение нельзя возвращать в пул: на нём остаётся незавершённая команда.
        try { destroy(); } finally {
          reject(dbError('DB_QUERY_TIMEOUT', name, `истекло время ${method}`));
        }
      }, queryTimeoutMs);
      Promise.resolve().then(() => connection[method](...args)).then(value => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    }));
    return {
      ...Object.fromEntries(['execute', 'query', 'beginTransaction', 'commit', 'rollback']
        .map(method => [method, (...args) => run(method, args)])),
      destroy,
      release() {
        if (!closed && !released) { released = true; connection.release(); }
      },
    };
  }

  function getConnection() {
    return withOperation(`db.${name}.acquire`, () => new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(dbError('DB_ACQUIRE_TIMEOUT', name, 'истекло ожидание свободного соединения'));
      }, acquireTimeoutMs);
      Promise.resolve().then(() => pool.getConnection()).then(connection => {
        // Просроченное ожидание не должно позже запустить INSERT/UPDATE.
        if (settled) { connection.release(); return; }
        settled = true; clearTimeout(timer); resolve(wrap(connection));
      }, error => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    }));
  }

  const execute = method => async (...args) => {
    const connection = await getConnection();
    try { return await connection[method](...args); } finally { connection.release(); }
  };
  return { execute: execute('execute'), query: execute('query'), getConnection, end: () => pool.end() };
}
