import { REDACT_MIN_LEN } from '../contract/constants.js';

export function typeHint(
  value: string,
): 'email' | 'phone' | 'number' | 'date' | 'url' | 'text-short' | 'text-long' {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return 'email';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(value)) return 'date';
  if (/^-?\d+([.,]\d+)?$/.test(value)) return 'number';
  if (/^\+?[\d\s()-]{7,}$/.test(value)) return 'phone';
  if (value.length <= 40) return 'text-short';
  return 'text-long';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactValues(text: string, values: Record<string, string>): string {
  const entries = Object.entries(values)
    .filter(([, v]) => v.length >= REDACT_MIN_LEN)
    .sort((a, b) => b[1].length - a[1].length);
  let result = text;
  for (const [name, value] of entries) {
    const re = new RegExp(escapeRegExp(value), 'gi');
    result = result.replace(re, `<value:${name}>`);
  }
  return result;
}

export function redactDeep<T>(x: T, values: Record<string, string>): T {
  if (typeof x === 'string') {
    return redactValues(x, values) as unknown as T;
  }
  if (Array.isArray(x)) {
    return x.map((item) => redactDeep(item, values)) as unknown as T;
  }
  if (x !== null && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      out[k] = redactDeep(v, values);
    }
    return out as unknown as T;
  }
  return x;
}

export function assertNoValues(serialized: string, values: Record<string, string>): void {
  const lower = serialized.toLowerCase();
  for (const [name, value] of Object.entries(values)) {
    if (value.length < REDACT_MIN_LEN) continue;
    if (lower.includes(value.toLowerCase())) {
      throw new Error(`value leak: ${name}`);
    }
  }
}
