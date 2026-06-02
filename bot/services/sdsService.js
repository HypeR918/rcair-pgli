import axios from 'axios';
import { env } from '../config/env.js';
import { normalizeEmail, sleep } from '../utils/textUtils.js';
import { findGlpiUserAfterSdsImport } from './dbService.js';

export async function requestGlpiLdapImport(email) {
  if (!env.GLPI_IMPORT_URL) {
    console.error('GLPI_IMPORT_URL is not configured');
    return false;
  }

  if (!env.GLPI_IMPORT_SECRET) {
    console.error('GLPI_IMPORT_SECRET is not configured');
    return false;
  }

  try {
    const res = await axios.post(
      env.GLPI_IMPORT_URL,
      { email },
      {
        headers: {
          Authorization: `Bearer ${env.GLPI_IMPORT_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: env.GLPI_IMPORT_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (res.status >= 200 && res.status < 300 && res.data?.ok === true) {
      console.log('=== GLPI CLI IMPORT SUCCESS ===');
      console.log('email:', email);
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