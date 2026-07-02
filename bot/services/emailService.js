import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const emailTransporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: String(env.SMTP_PORT) === '465',
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

export function generateEmailVerificationCode() {
  return String(crypto.randomInt(100000, 999999 + 1));
}

export function hashVerificationCode(code) {
  return crypto.createHmac('sha256', env.EMAIL_CODE_SECRET).update(code).digest('hex');
}

export function verifyCodeHash(code, hash) {
  if (!code || !hash || typeof code !== 'string' || typeof hash !== 'string') {
    return false;
  }

  const expected = hashVerificationCode(code);

  if (expected.length !== hash.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

export async function sendEmailVerificationCode(email, code) {
  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return;
  }

  try {
    await emailTransporter.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: email,
      subject: 'Код подтверждения email',
      text: `Ваш код подтверждения: ${code}`,
    });
  } catch (error) {
    // не логируем сам код, только ошибку доставки
    console.error('sendEmailVerificationCode error:', error.message);
    throw new Error('Не удалось отправить код подтверждения');
  }
}
