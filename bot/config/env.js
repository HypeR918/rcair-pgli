import 'dotenv/config';

export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN,

  PORT: Number(process.env.PORT || 3000),

  DB_HOST: process.env.DB_HOST,
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,

  BOT_DB_HOST: process.env.BOT_DB_HOST || process.env.DB_HOST,
  BOT_DB_PORT: Number(process.env.BOT_DB_PORT || process.env.DB_PORT || 3306),
  BOT_DB_USER: process.env.BOT_DB_USER || process.env.DB_USER,
  BOT_DB_PASSWORD: process.env.BOT_DB_PASSWORD || process.env.DB_PASSWORD,
  BOT_DB_NAME: process.env.BOT_DB_NAME || process.env.DB_NAME,

  GLPI_DB_HOST: process.env.GLPI_DB_HOST || process.env.DB_HOST,
  GLPI_DB_PORT: Number(process.env.GLPI_DB_PORT || process.env.DB_PORT || 3306),
  GLPI_DB_USER: process.env.GLPI_DB_USER || process.env.DB_USER,
  GLPI_DB_PASSWORD: process.env.GLPI_DB_PASSWORD || process.env.DB_PASSWORD,
  GLPI_DB_NAME: process.env.GLPI_DB_NAME || process.env.DB_NAME || 'glpi',

  EMAIL_VERIFICATION_ENABLED:
    String(process.env.EMAIL_VERIFICATION_ENABLED || 'false').toLowerCase() === 'true',

  EMAIL_CODE_SECRET: process.env.EMAIL_CODE_SECRET || process.env.BOT_TOKEN,
  EMAIL_CODE_RESEND_COOLDOWN_MS: Number(process.env.EMAIL_CODE_RESEND_COOLDOWN_MS || 60000),
  EMAIL_CODE_MAX_ATTEMPTS: Number(process.env.EMAIL_CODE_MAX_ATTEMPTS || 3),
  EMAIL_CODE_TTL_MS: Number(process.env.EMAIL_CODE_TTL_MS || 10 * 60 * 1000),

  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT || 465),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_FROM: process.env.SMTP_FROM,

  GLPI_IMPORT_URL: process.env.GLPI_IMPORT_URL,
  GLPI_IMPORT_SECRET: process.env.GLPI_IMPORT_SECRET,
  GLPI_IMPORT_TIMEOUT_MS: Number(process.env.GLPI_IMPORT_TIMEOUT_MS || 130000),
  GLPI_IMPORT_CHECK_ATTEMPTS: Number(process.env.GLPI_IMPORT_CHECK_ATTEMPTS || 10),
  GLPI_IMPORT_CHECK_DELAY_MS: Number(process.env.GLPI_IMPORT_CHECK_DELAY_MS || 1500),

  GLPI_API_URL: process.env.GLPI_API_URL,
  GLPI_API_USER_TOKEN: process.env.GLPI_API_USER_TOKEN,
  GLPI_API_APP_TOKEN: process.env.GLPI_API_APP_TOKEN,

  GLPI_ENTITY_ID: Number(process.env.GLPI_ENTITY_ID || 0),

  GLPI_DEFAULT_TICKET_TYPE: Number(process.env.GLPI_DEFAULT_TICKET_TYPE || 1),
  GLPI_DEFAULT_REQUEST_TYPE_ID: Number(process.env.GLPI_DEFAULT_REQUEST_TYPE_ID || 1),
  GLPI_DEFAULT_REQUEST_CATEGORY_ID: Number(process.env.GLPI_DEFAULT_REQUEST_CATEGORY_ID || 0),
  GLPI_DEFAULT_ASSIGN_GROUP_ID: Number(process.env.GLPI_DEFAULT_ASSIGN_GROUP_ID || 0),

  GLPI_APPROVAL_POLL_MS: Number(process.env.GLPI_APPROVAL_POLL_MS || 60000),
  GLPI_TICKET_POLL_MS: Number(process.env.GLPI_TICKET_POLL_MS || 60000),
};

export function requireEnv() {
  const required = [
    'BOT_TOKEN',

    'BOT_DB_HOST',
    'BOT_DB_USER',
    'BOT_DB_NAME',

    'GLPI_DB_HOST',
    'GLPI_DB_USER',
    'GLPI_DB_NAME',

    'GLPI_IMPORT_URL',
    'GLPI_IMPORT_SECRET',
    'GLPI_API_URL',
    'GLPI_API_USER_TOKEN',
  ];

  const missing = required.filter(name => {
    const value = env[name];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new Error(`Не заданы переменные окружения: ${missing.join(', ')}`);
  }
}