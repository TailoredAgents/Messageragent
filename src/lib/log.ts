import pino, { type Logger, type LogFn } from 'pino';
import process from 'node:process';

type LoggerFields = Record<string, unknown>;

type RedactionOptions = {
  email?: string | null;
  phone?: string | null;
  token?: string | null;
  url?: string | null;
  text?: string | null;
};

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

const FULL_MASK_KEYS = new Set([
  'psid',
  'messengerPsid',
  'token',
  'secret',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'key',
  'password',
  'session',
  'cookie',
  'phone',
  'email',
  'to',
  'from',
]);

const SUMMARY_MASK_KEYS = new Set([
  'text',
  'body',
  'message',
  'content',
  'payload',
  'address',
  'attachments',
  'notes',
]);

export type LoggerInstance = {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child: (bindings?: LoggerFields) => LoggerInstance;
  redact: typeof redactValues;
};

export function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, parentKey));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: process.env.LOG_INCLUDE_STACKS === 'true' ? value.stack : undefined,
    };
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = sanitizeValue(nestedValue, key);
    }
    return result;
  }

  const normalizedKey = parentKey?.toLowerCase();
  if (typeof value === 'string') {
    if (normalizedKey && normalizedKey.includes('url')) {
      return maskUrl(value);
    }
    if (normalizedKey && FULL_MASK_KEYS.has(normalizedKey)) {
      return `[redacted:${normalizedKey}]`;
    }
    if (normalizedKey && SUMMARY_MASK_KEYS.has(normalizedKey)) {
      return maskText(value, normalizedKey);
    }
    return value;
  }

  if (
    (typeof value === 'number' || typeof value === 'boolean') &&
    normalizedKey &&
    FULL_MASK_KEYS.has(normalizedKey)
  ) {
    return `[redacted:${normalizedKey}]`;
  }

  return value;
}

export function maskText(value: string, key?: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '[masked-empty]';
  }
  const snippet = normalized.slice(0, 64);
  const suffix = normalized.length > 64 ? '…' : '';
  return `[masked:${key ?? 'value'} len=${normalized.length} snippet="${snippet}${suffix}"]`;
}

export function maskUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const truncatedPath =
      parsed.pathname.length > 32
        ? `${parsed.pathname.slice(0, 32)}…`
        : parsed.pathname || '/';
    return `[masked:url host=${parsed.host} path=${truncatedPath}]`;
  } catch {
    return maskText(raw, 'url');
  }
}

export function maskPhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 2) return '[redacted:phone]';
  return `[redacted:phone ***${digits.slice(-2)}]`;
}

export function maskEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const [user, domain] = raw.split('@');
  if (!domain) return '[redacted:email]';
  const prefix = user.slice(0, 1) || '*';
  return `${prefix}${'*'.repeat(Math.max(0, user.length - 1))}@${domain}`;
}

export function maskToken(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const hash = Buffer.from(raw).toString('hex');
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function redactValues(options: RedactionOptions): Record<string, string> {
  return {
    email: options.email ? maskEmail(options.email) ?? '[redacted:email]' : '[redacted:email]',
    phone: options.phone ? maskPhone(options.phone) ?? '[redacted:phone]' : '[redacted:phone]',
    token: options.token ? maskToken(options.token) ?? '[redacted:token]' : '[redacted:token]',
    url: options.url ? maskUrl(options.url) : '[redacted:url]',
    text: options.text ? maskText(options.text) : '[redacted:text]',
  };
}

function wrapLogger(base: Logger): LoggerInstance {
  const emit = (fn: LogFn, bindingsOrMsg?: unknown, maybeMsg?: unknown) => {
    if (typeof bindingsOrMsg === 'string') {
      fn(bindingsOrMsg);
      return;
    }
    const sanitized = sanitizeValue(bindingsOrMsg) as LoggerFields;
    if (typeof maybeMsg === 'string') {
      fn(sanitized, maybeMsg);
      return;
    }
    fn(sanitized);
  };

  return {
    info: (bindingsOrMsg?: unknown, msg?: string) => emit(base.info.bind(base), bindingsOrMsg, msg),
    warn: (bindingsOrMsg?: unknown, msg?: string) => emit(base.warn.bind(base), bindingsOrMsg, msg),
    error: (bindingsOrMsg?: unknown, msg?: string) => emit(base.error.bind(base), bindingsOrMsg, msg),
    child: (bindings?: LoggerFields) => wrapLogger(base.child(bindings ?? {})),
    redact: redactValues,
  };
}

export function getLogger(): LoggerInstance {
  return wrapLogger(rootLogger);
}

export function wrapFastifyLogger(fastifyLogger: Logger): LoggerInstance {
  return wrapLogger(fastifyLogger);
}

export function loggerChild(bindings: LoggerFields): LoggerInstance {
  return wrapLogger(rootLogger.child(bindings));
}

export function getRawLogger(): Logger {
  return rootLogger;
}
