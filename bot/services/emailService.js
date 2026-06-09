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
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function sendEmailVerificationCode(email, code) {
  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return;
  }

  await emailTransporter.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to: email,
    subject: 'Код подтверждения email',
    text: `Ваш код подтверждения: ${code}`,
  });
}