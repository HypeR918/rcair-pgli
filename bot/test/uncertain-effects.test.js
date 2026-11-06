import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIsolated } from './helpers/isolated.mjs';
import * as operations from '../utils/operationContext.js';

for (const mode of ['server-error', 'network-error', 'read-error', 'forbidden']) {
  test(`GLPI ${mode}: неизвестный результат записи виден worker после catch контроллера`, async () => {
    const axios = async () => {
      if (mode === 'network-error') throw new Error('offline network');
      return { status: mode === 'forbidden' ? 403 : 503, data: {} };
    };
    axios.get = async () => ({ status: 200, data: { session_token: 'offline-session' } });
    const service = await loadIsolated('services/glpiService.js', {
      './config/env.js': { env: { GLPI_API_URL: 'https://offline.invalid/apirest.php', GLPI_API_USER_TOKEN: 'offline', GLPI_API_TIMEOUT_MS: 1000 } },
      './utils/operationContext.js': operations,
      axios: { default: axios },
    });
    const scope = operations.createOperationScope(() => {});
    await scope.run(async () => {
      try { await service.glpiApiRequest(mode === 'read-error' ? 'GET' : 'POST', '/Ticket', { input: {} }); } catch {}
    });
    assert.deepEqual(scope.ambiguousEffects, ['server-error', 'network-error'].includes(mode) ? ['glpi.write'] : []);
  });
}
