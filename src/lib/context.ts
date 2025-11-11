import { Prisma } from '@prisma/client';

import { prisma } from './prisma.ts';
import { ContextCandidate } from './types.ts';

const DEFAULT_CANDIDATE_LIMIT = 5;
const JOB_FETCH_MULTIPLIER = 3;
const LEAD_FETCH_MULTIPLIER = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const AMBIGUOUS_SCORE_DELTA = 0.05;

export const ADDRESS_CONFIRM_YES = 'ADDRESS_CONFIRM_YES';
export const ADDRESS_CONFIRM_DIFFERENT = 'ADDRESS_CONFIRM_DIFFERENT';

export type ContextConfirmationChoice = 'yes' | 'different';

const YES_KEYWORDS = ['yes', 'y', 'yeah', 'yep', 'ya', 'sure', 'correct', 'right'];
const NO_KEYWORDS = ['no', 'n', 'nope', 'nah'];
const DIFFERENT_KEYWORDS = ['different', 'diff', 'another', 'other', 'not that', 'new address'];

type JobWithLead = Prisma.JobGetPayload<{ include: { lead: true } }>;
type LeadRecord = Prisma.LeadGetPayload<{}>;
type CustomerAddressRecord = Prisma.CustomerAddressGetPayload<{}>;

type NormalizedAddress = {
  id: string;
  label: string;
  normalized: string | null;
};

export async function fetchContextCandidates(
  customerId: string | null | undefined,
  queryText: string,
  k = DEFAULT_CANDIDATE_LIMIT,
): Promise<ContextCandidate[]> {
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : DEFAULT_CANDIDATE_LIMIT;
  if (!customerId) {
    return [];
  }

  const [jobs, leads, addresses] = await Promise.all([
    prisma.job.findMany({
      where: { customerId },
      orderBy: { windowStart: 'desc' },
      include: { lead: true },
      take: Math.max(limit * JOB_FETCH_MULTIPLIER, limit),
    }),
    prisma.lead.findMany({
      where: {
        customerId,
        jobs: { none: {} },
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(limit * LEAD_FETCH_MULTIPLIER, limit),
    }),
    prisma.customerAddress.findMany({
      where: { customerId },
    }),
  ]);

  const addressIndex = buildAddressIndex(addresses ?? []);
  const queryTokens = tokenize(queryText);
  const nowMs = Date.now();
  const candidates: ContextCandidate[] = [];

  for (const job of jobs ?? []) {
    const candidate = buildJobCandidate(job, addressIndex);
    candidate.score = scoreCandidate(candidate, queryTokens, nowMs);
    candidates.push(candidate);
  }

  for (const lead of leads ?? []) {
    const candidate = buildLeadCandidate(lead, addressIndex);
    candidate.score = scoreCandidate(candidate, queryTokens, nowMs);
    candidates.push(candidate);
  }

  return candidates
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime();
    })
    .slice(0, limit);
}

export function getAmbiguousContextCandidates(
  candidates: ContextCandidate[],
  delta = AMBIGUOUS_SCORE_DELTA,
): ContextCandidate[] {
  if (candidates.length < 2) {
    return [];
  }
  const [first, second] = candidates;
  const firstScore = first.score ?? 0;
  const secondScore = second.score ?? 0;
  if (Math.abs(firstScore - secondScore) <= delta) {
    return candidates.slice(0, 2);
  }
  return [];
}

export function summarizeCandidateOption(candidate: ContextCandidate): string {
  const dateLabel = candidate.lastInteractionAt
    ? formatMonthDay(candidate.lastInteractionAt)
    : 'recent';
  const address = candidate.addressLine ?? 'address pending';
  return `${dateLabel} · ${address}`;
}

export function buildAddressConfirmPrompt(candidate: ContextCandidate): string {
  const addressLabel = candidate.addressLine
    ? candidate.addressLine
    : candidate.summary;
  const dateLabel = candidate.lastInteractionAt
    ? formatMonthDay(candidate.lastInteractionAt)
    : null;
  if (dateLabel) {
    return `Quick check: is this the same address at ${addressLabel} from ${dateLabel}?`;
  }
  return `Quick check: is this the same address at ${addressLabel}?`;
}

export async function attachConfirmedContext(
  conversationId: string | null | undefined,
  candidateIds: string[],
): Promise<void> {
  if (!conversationId || candidateIds.length === 0) {
    return;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { metadata: true },
  });
  if (!conversation) {
    return;
  }

  const metadata =
    (conversation.metadata as Prisma.JsonObject | null | undefined) ?? {};
  const contextMemory = extractContextMemory(metadata);
  const dedupedIds = Array.from(new Set(candidateIds));
  const nextMetadata: Prisma.JsonObject = {
    ...metadata,
    context_memory: {
      ...contextMemory,
      confirmed_candidate_ids: dedupedIds,
      confirmed_at: new Date().toISOString(),
    },
  };

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { metadata: nextMetadata },
  });
}

function buildJobCandidate(
  job: JobWithLead,
  addressIndex: NormalizedAddress[],
): ContextCandidate {
  const leadAddress = job.lead?.address ?? null;
  const resolvedAddress = resolveAddress(leadAddress, addressIndex);
  const lastInteractionAt =
    job.windowEnd ??
    job.windowStart ??
    job.updatedAt ??
    job.createdAt ??
    new Date();
  const category =
    extractCategory(job.lead?.stateMetadata ?? null) ?? job.status ?? undefined;

  return {
    id: `job:${job.id}`,
    source: 'job',
    jobId: job.id,
    leadId: job.leadId,
    customerId: job.customerId,
    addressId: resolvedAddress?.id ?? null,
    addressLine: resolvedAddress?.label ?? leadAddress ?? undefined,
    category,
    lastInteractionAt: new Date(lastInteractionAt),
    summary: buildJobSummary(job, resolvedAddress?.label ?? leadAddress ?? null),
    score: 0,
  };
}

function buildLeadCandidate(
  lead: LeadRecord,
  addressIndex: NormalizedAddress[],
): ContextCandidate {
  const resolvedAddress = resolveAddress(lead.address ?? null, addressIndex);
  const lastInteractionAt = lead.updatedAt ?? lead.createdAt ?? new Date();
  return {
    id: `lead:${lead.id}`,
    source: 'lead',
    leadId: lead.id,
    customerId: lead.customerId,
    addressId: resolvedAddress?.id ?? null,
    addressLine: resolvedAddress?.label ?? lead.address ?? undefined,
    category: extractCategory(lead.stateMetadata ?? null),
    lastInteractionAt: new Date(lastInteractionAt),
    summary: buildLeadSummary(lead, resolvedAddress?.label ?? lead.address ?? null),
    score: 0,
  };
}

function buildJobSummary(job: JobWithLead, addressLine: string | null): string {
  const dateLabel = job.windowStart
    ? formatMonthDay(new Date(job.windowStart))
    : formatMonthDay(new Date(job.updatedAt ?? job.createdAt ?? Date.now()));
  const status = job.status ? job.status.toLowerCase() : 'job';
  const prettyAddress = addressLine ?? 'address pending';
  return `${status} · ${dateLabel} · ${prettyAddress}`;
}

function buildLeadSummary(lead: LeadRecord, addressLine: string | null): string {
  const dateLabel = formatMonthDay(new Date(lead.updatedAt ?? lead.createdAt ?? Date.now()));
  const prettyAddress = addressLine ?? 'address pending';
  return `conversation · ${dateLabel} · ${prettyAddress}`;
}

function scoreCandidate(
  candidate: ContextCandidate,
  queryTokens: string[],
  nowMs: number,
): number {
  const ageDays = Math.max(
    0,
    (nowMs - candidate.lastInteractionAt.getTime()) / DAY_MS,
  );
  const recencyScore = 1 / (1 + ageDays / 7);

  if (queryTokens.length === 0) {
    return Number(recencyScore.toFixed(4));
  }

  const candidateTokens = new Set(
    tokenize(
      [candidate.addressLine ?? '', candidate.summary, candidate.category ?? ''].join(
        ' ',
      ),
    ),
  );
  const addressTokens = new Set(tokenize(candidate.addressLine ?? ''));

  const textMatches = queryTokens.filter((token) => candidateTokens.has(token))
    .length;
  const keywordScore = textMatches / queryTokens.length;
  const addressOverlap =
    Array.from(addressTokens).filter((token) => queryTokens.includes(token))
      .length >= 2;
  const categoryMatch =
    candidate.category !== undefined &&
    tokenize(candidate.category).some((token) => queryTokens.includes(token));

  const score =
    recencyScore * 0.5 +
    keywordScore * 0.35 +
    (addressOverlap ? 0.1 : 0) +
    (categoryMatch ? 0.05 : 0);
  return Number(score.toFixed(4));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(Boolean) ?? [];
}

function buildAddressIndex(addresses: CustomerAddressRecord[]): NormalizedAddress[] {
  return (addresses ?? []).map((address) => {
    const label = buildAddressLabel(address);
    return {
      id: address.id,
      label,
      normalized: normalizeAddress(label),
    };
  });
}

function buildAddressLabel(address: CustomerAddressRecord): string {
  const parts = [
    address.address?.trim(),
    address.city?.trim(),
    address.state?.trim(),
    address.zip?.trim(),
  ].filter((part): part is string => Boolean(part && part.length > 0));
  return parts.join(', ');
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveAddress(
  rawAddress: string | null,
  addressIndex: NormalizedAddress[],
): { id: string | null; label: string } | null {
  if (!rawAddress) {
    return null;
  }
  const normalized = normalizeAddress(rawAddress);
  if (!normalized) {
    return null;
  }
  const match =
    addressIndex.find((entry) => {
      if (!entry.normalized) {
        return false;
      }
      return (
        normalized.includes(entry.normalized) ||
        entry.normalized.includes(normalized)
      );
    }) ?? null;

  if (match) {
    return { id: match.id, label: match.label };
  }
  return { id: null, label: rawAddress };
}

function extractCategory(value: Prisma.JsonValue | null): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const category = (value as Record<string, unknown>).category;
  return typeof category === 'string' ? category : undefined;
}

function formatMonthDay(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function extractContextMemory(value: Prisma.JsonObject): Prisma.JsonObject {
  const raw = value.context_memory;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Prisma.JsonObject;
}

export function parseContextConfirmationInput(
  payload: string | null | undefined,
  text: string | null | undefined,
): ContextConfirmationChoice | null {
  if (payload === ADDRESS_CONFIRM_YES) {
    return 'yes';
  }
  if (payload === ADDRESS_CONFIRM_DIFFERENT) {
    return 'different';
  }

  const normalized = text?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return null;
  }

  if (YES_KEYWORDS.some((keyword) => normalized === keyword || normalized.startsWith(`${keyword} `))) {
    return 'yes';
  }

  if (
    NO_KEYWORDS.some((keyword) => normalized === keyword || normalized.startsWith(`${keyword} `)) ||
    DIFFERENT_KEYWORDS.some(
      (keyword) => normalized === keyword || normalized.includes(keyword),
    )
  ) {
    return 'different';
  }

  return null;
}

export type SerializedCandidate = Omit<ContextCandidate, 'lastInteractionAt'> & {
  lastInteractionAt: string;
};

export function serializeCandidate(candidate: ContextCandidate): SerializedCandidate {
  return {
    ...candidate,
    lastInteractionAt: candidate.lastInteractionAt.toISOString(),
  };
}

export function deserializeCandidate(
  serialized: string | null | undefined,
): ContextCandidate | null {
  if (!serialized) {
    return null;
  }
  try {
    const parsed = JSON.parse(serialized) as SerializedCandidate;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      ...parsed,
      lastInteractionAt: new Date(parsed.lastInteractionAt),
    };
  } catch {
    return null;
  }
}
