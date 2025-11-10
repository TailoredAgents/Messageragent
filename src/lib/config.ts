import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export type TenantConfig = {
  tenant: string;
  service_area: {
    mode: string;
    center: { lat: number; lng: number };
    radius_miles: number;
    allowed_counties: string[];
    travel_baseline_miles: number;
    travel_excess_rate_per_mile: number;
  };
  channels: Record<string, { enabled: boolean }>;
  reminders: { t_minus_hours: number[] };
  quote_policy: {
    disclaimer: string;
    auto_approve_cap: number;
    hazard_keywords: string[];
  };
  pricebook: unknown;
  timeZone?: string;
};

type RawTenantConfig = TenantConfig & {
  time_zone?: string;
  timezone?: string;
};

const DEFAULT_TENANT_TIME_ZONE = 'America/New_York';
const TRUE_LITERALS = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_LITERALS = new Set(['0', 'false', 'no', 'off', 'n']);

let cachedConfig: TenantConfig | null = null;
let cachedTenantTimeZone: string | null = null;

export async function loadTenantConfig(): Promise<TenantConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), 'config', 'junk.json');
  const contents = await readFile(configPath, 'utf8');
  const raw = JSON.parse(contents) as RawTenantConfig;
  cachedConfig = {
    ...raw,
    timeZone: normalizeString(raw.timeZone ?? raw.time_zone ?? raw.timezone),
  };
  if (!cachedTenantTimeZone && cachedConfig.timeZone) {
    cachedTenantTimeZone = cachedConfig.timeZone;
  }
  return cachedConfig;
}

function normalizeString(value?: string | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBoolean(
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  if (typeof rawValue !== 'string') {
    return defaultValue;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized.length === 0) {
    return defaultValue;
  }
  if (TRUE_LITERALS.has(normalized)) {
    return true;
  }
  if (FALSE_LITERALS.has(normalized)) {
    return false;
  }
  return defaultValue;
}

export function isContextMemoryEnabled(): boolean {
  return normalizeBoolean(process.env.CONTEXT_MEMORY_ENABLED, false);
}

export function isStrictAddressConfirmationEnabled(): boolean {
  return normalizeBoolean(process.env.CONTEXT_STRICT_ADDRESS_CONFIRMATION, true);
}

export function getTenantTimeZone(): string {
  if (cachedTenantTimeZone) {
    return cachedTenantTimeZone;
  }

  const envTz =
    normalizeString(process.env.TENANT_TIMEZONE) ??
    normalizeString(process.env.TENANT_TIME_ZONE);
  if (envTz) {
    cachedTenantTimeZone = envTz;
    return cachedTenantTimeZone;
  }

  if (cachedConfig?.timeZone) {
    cachedTenantTimeZone = cachedConfig.timeZone;
    return cachedTenantTimeZone;
  }

  cachedTenantTimeZone = DEFAULT_TENANT_TIME_ZONE;
  return cachedTenantTimeZone;
}
