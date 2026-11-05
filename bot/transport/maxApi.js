import axios from 'axios';
import { assertWebhookApiPath, MAX_API_URL } from './config.js';

// В SDK 0.2.5 нет методов управления подписками. Используем тот же HTTPS API.
export function createMaxApi(token, baseURL = MAX_API_URL) {
  return async (method, path, data) => {
    assertWebhookApiPath(path);
    try {
      const response = await axios({
        baseURL, url: path, method, data,
        headers: { Authorization: token },
        timeout: 30000,
        maxRedirects: 0,
      });
      return response.data;
    } catch (error) {
      // AxiosError содержит Authorization в config: его нельзя передавать в лог.
      const reason = error.response?.status ? `HTTP ${error.response.status}` : 'ошибка соединения';
      throw new Error(`MAX API ${method} ${path}: ${reason}`);
    }
  };
}
