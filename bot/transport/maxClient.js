import axios from 'axios';
import { MAX_API_URL, assertWebhookApiPath } from './config.js';

export const MAX_API_TIMEOUT_MS = 30000;

// Публичный интерфейс Client SDK: call({ method: 'messages', options: {...} }).
// Axios используется и для подписки, и для ответов: одинаковые TLS/proxy/таймауты.
export function createMaxClient(token, { baseUrl = MAX_API_URL, timeout = MAX_API_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new Error('Таймаут MAX API должен быть положительным числом миллисекунд');
  }
  const base = new URL(baseUrl);
  return {
    async call({ method, options = {} }) {
      let path = method;
      for (const [name, value] of Object.entries(options.path || {})) {
        path = path.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
      }
      assertWebhookApiPath(path);
      const url = new URL(path, base);
      if (url.origin !== base.origin || url.username || url.password) {
        throw new Error('MAX API: запрещён запрос к другому серверу');
      }
      const httpMethod = (options.method || 'GET').toUpperCase();
      const params = Object.fromEntries(Object.entries(options.query || {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([name, value]) => [name, String(value)]));
      try {
        const response = await axios({
          url: url.href, method: httpMethod, params, data: options.body,
          headers: { Authorization: token },
          timeout, signal: AbortSignal.timeout(timeout),
          maxRedirects: 0, validateStatus: () => true,
          responseType: 'json', transitional: { silentJSONParsing: false },
        });
        return { status: response.status, data: response.data };
      } catch (error) {
        // Не возвращаем AxiosError: в config находятся токен и текст сообщения.
        const timedOut = ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(error.code);
        const reason = timedOut ? `истекло время ожидания (${timeout} мс)` : 'ошибка соединения или ответа';
        const safe = new Error(`MAX API ${httpMethod} ${method}: ${reason}`);
        safe.code = timedOut ? 'MAX_API_TIMEOUT' : 'MAX_API_CONNECTION';
        throw safe;
      }
    },
  };
}
