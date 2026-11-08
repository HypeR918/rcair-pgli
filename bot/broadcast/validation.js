export function normalizeTestRecipient(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    const error = new Error('Нужен положительный MAX ID тестового получателя');
    error.code = 'BROADCAST_INVALID_RECIPIENT'; throw error;
  }
  return value;
}
