import { MAX_API_URL } from './config.js';
import { createMaxClient } from './maxClient.js';

// В SDK 0.2.5 нет методов управления подписками. Используем тот же HTTPS API.
export function createMaxApi(token, baseURL = MAX_API_URL) {
  const client = createMaxClient(token, { baseUrl: baseURL });
  return async (method, path, data) => {
    const response = await client.call({ method: path, options: { method, body: data } });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MAX API ${method} ${path}: HTTP ${response.status}`);
    }
    return response.data;
  };
}
