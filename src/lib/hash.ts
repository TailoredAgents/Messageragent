import { createHash } from 'node:crypto';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([keyA], [keyB]) => keyA.localeCompare(keyB),
  );

  const serialized = entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',');

  return `{${serialized}}`;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function hashStrings(values: string[]): string {
  const normalized = [...values].sort().join('|');
  return createHash('sha256').update(normalized).digest('hex');
}
