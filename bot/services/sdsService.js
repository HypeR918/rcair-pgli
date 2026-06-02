import axios from 'axios';
import { env } from '../config/env.js';
import { normalizeEmail, sleep } from '../utils/textUtils.js';
import { findGlpiUserAfterSdsImport } from './dbService.js';

export async function requestGlpiLdapImport(email) {
  const importUrl = String(env.GLPI_IMPORT_URL || '').trim();
  const importSecret = String(env.GLPI_IMPORT_SECRET || '').trim();
  const normalizedEmail = normalizeEmail(email);

  if (!importUrl) {
    console.error('GLPI_IMPORT_URL is not configured');
    return false;
  }

  if (!importSecret) {
    console.error('GLPI_IMPORT_SECRET is not configured');
    return false;
  }

  const payload = JSON.stringify({
    email: normalizedEmail,
  });

  try {
    console.log('=== GLPI CLI IMPORT REQUEST ===');
    console.log('url:', importUrl);
    console.log('email:', normalizedEmail);
    console.log('payload:', payload);
    console.log('secret length:', importSecret.length);

    const res = await axios.post(
      importUrl,
      payload,
      {
        headers: {
          Authorization: `Bearer ${importSecret}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
        timeout: env.GLPI_IMPORT_TIMEOUT_MS,
        validateStatus: () => true,
        transformRequest: data => data,
      }
    );

    if (res.status >= 200 && res.status < 300 && res.data?.ok === true) {
      console.log('=== GLPI CLI IMPORT SUCCESS ===');
      console.log('email:', normalizedEmail);
      console.log('filter:', res.data.filter);
      return true;
    }

    console.error('=== GLPI CLI IMPORT FAILED ===');
    console.error('status:', res.status);
    console.error('data:', res.data);
    return false;
  } catch (err) {
    console.error('=== GLPI CLI IMPORT REQUEST ERROR ===');
    console.error(err.message);

    if (err.response) {
      console.error('response status:', err.response.status);
      console.error('response data:', err.response.data);
    }

    return false;
  }
}

export async function importUserFromSdsViaGlpi(email) {
  const normalizedEmail = normalizeEmail(email);

  console.log('=== SDS/GLPI IMPORT START ===');
  console.log('email:', normalizedEmail);

  const importRequested = await requestGlpiLdapImport(normalizedEmail);

  if (!importRequested) {
    console.log('=== GLPI CLI IMPORT WAS NOT STARTED OR FAILED ===');
    return null;
  }

  console.log('=== CHECKING GLPI USER AFTER SDS IMPORT ===');

  for (let attempt = 1; attempt <= env.GLPI_IMPORT_CHECK_ATTEMPTS; attempt += 1) {
    await sleep(env.GLPI_IMPORT_CHECK_DELAY_MS);

    const user = await findGlpiUserAfterSdsImport(normalizedEmail);

    if (user) {
      console.log('=== USER FOUND AFTER SDS IMPORT ===');
      console.log('user id:', user.id);
      console.log('attempt:', attempt);
      return user;
    }
  }

  console.log('=== USER NOT FOUND AFTER SDS IMPORT ===');
  return null;
}