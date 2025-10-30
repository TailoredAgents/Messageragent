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
};

let cachedConfig: TenantConfig | null = null;

export async function loadTenantConfig(): Promise<TenantConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), 'config', 'junk.json');
  const contents = await readFile(configPath, 'utf8');
  cachedConfig = JSON.parse(contents) as TenantConfig;
  return cachedConfig;
}

