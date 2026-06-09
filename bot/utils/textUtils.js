import crypto from 'node:crypto';
import { approveWords, rejectWords } from './constants.js';

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function textHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

export function truncateText(value, maxLength = 3500) {
  const text = String(value || '').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

export function getTicketStatusLabel(status) {
  const value = Number(status);

  if (value === 1) return 'Новая';
  if (value === 2) return 'В работе';
  if (value === 3) return 'Запланирована';
  if (value === 4) return 'Ожидает';
  if (value === 5) return 'Решена';
  if (value === 6) return 'Закрыта';

  return `Статус ${value || '-'}`;
}

export function parseDecisionText(text) {
  const normalized = stripHtml(text).trim();

  if (!normalized) {
    return null;
  }

  const upper = normalized.toUpperCase();

  const hasApprove = approveWords.some(word => upper.includes(word));
  const hasReject = rejectWords.some(word => upper.includes(word));

  if (hasApprove && !hasReject) {
    return {
      status: 'APPROVED',
      text: normalized,
    };
  }

  if (hasReject && !hasApprove) {
    return {
      status: 'REJECTED',
      text: normalized,
    };
  }

  if (hasApprove && hasReject) {
    console.log('Decision text contains both approve and reject words:', normalized);
    return null;
  }

  return null;
}