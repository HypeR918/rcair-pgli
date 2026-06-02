export function isValidEmail(value) {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

export function isNotEmptyText(value, minLength = 1) {
  return String(value || '').trim().length >= minLength;
}