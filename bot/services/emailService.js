import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { withOperation } from '../utils/operationContext.js';

const smtpPort = Number(env.SMTP_PORT || 587);
const smtpTimeout = env.SMTP_TIMEOUT_MS ?? 10000;
const emailTransporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  connectionTimeout: smtpTimeout,
  greetingTimeout: smtpTimeout,
  socketTimeout: smtpTimeout,
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
});

export function generateEmailVerificationCode() {
  return String(crypto.randomInt(100000, 999999 + 1));
}

export function hashVerificationCode(code) {
  return crypto
    .createHmac('sha256', env.EMAIL_CODE_SECRET)
    .update(code)
    .digest('hex');
}

export function verifyCodeHash(code, hash) {
  if (!code || !hash || typeof code !== 'string' || typeof hash !== 'string') {
    return false;
  }

  const expected = hashVerificationCode(code);

  if (expected.length !== hash.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(hash)
  );
}

export async function sendEmailVerificationCode(email, code) {
  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return;
  }

  return withOperation('smtp.send', async () => {
    try {
      await emailTransporter.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: 'Код подтверждения email',
        text: `Ваш код подтверждения: ${code}`,
      });
    } catch (error) {
      console.error('sendEmailVerificationCode error:', error.message);
      throw new Error('Не удалось отправить код подтверждения');
    }
  });
}
