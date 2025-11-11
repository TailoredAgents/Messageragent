
import { prisma } from './prisma.ts';
import { loadTenantConfig } from './config.ts';

export type AgentRuntimeStatus = {
  paused: boolean;
  updatedAt: Date;
  updatedBy?: string | null;
};

const CACHE_TTL_MS = 5_000;
let cachedStatus: { value: AgentRuntimeStatus; expiresAt: number } | null = null;

async function loadStateFromDb(): Promise<AgentRuntimeStatus> {
  const config = await loadTenantConfig();
  const tenantId = config.tenant;

  const state = await prisma.agentRuntimeState.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, agentPaused: false },
  });

  return {
    paused: state.agentPaused,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

export async function getAgentRuntimeStatus(force = false): Promise<AgentRuntimeStatus> {
  const now = Date.now();
  if (!force && cachedStatus && cachedStatus.expiresAt > now) {
    return cachedStatus.value;
  }

  const value = await loadStateFromDb();
  cachedStatus = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function isAgentPaused(): Promise<boolean> {
  const status = await getAgentRuntimeStatus();
  return status.paused;
}

export async function setAgentPaused(paused: boolean, updatedBy?: string | null): Promise<AgentRuntimeStatus> {
  const config = await loadTenantConfig();
  const tenantId = config.tenant;

  const state = await prisma.agentRuntimeState.upsert({
    where: { tenantId },
    update: { agentPaused: paused, updatedBy: updatedBy ?? null },
    create: { tenantId, agentPaused: paused, updatedBy: updatedBy ?? null },
  });

  const result: AgentRuntimeStatus = {
    paused: state.agentPaused,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
  cachedStatus = { value: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
