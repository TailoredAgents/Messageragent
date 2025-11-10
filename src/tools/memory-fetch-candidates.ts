import { tool } from '@openai/agents';
import { z } from 'zod';

import { fetchContextCandidates } from '../lib/context.ts';
import { prisma } from '../lib/prisma.ts';
import { ContextCandidate } from '../lib/types.ts';

const memoryFetchCandidatesParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    query_text: z
      .string()
      .trim()
      .min(1, 'query_text must be a non-empty string')
      .max(500, 'query_text cannot exceed 500 characters'),
    k: z
      .number()
      .int('k must be a whole number')
      .min(1, 'k must be at least 1')
      .max(10, 'k cannot exceed 10')
      .nullish(),
  })
  .transform((input) => ({
    ...input,
    k: input.k ?? undefined,
  }));

type MemoryFetchCandidatesInput = z.infer<typeof memoryFetchCandidatesParameters>;

type MemoryFetchCandidatesResult = {
  lead_id: string;
  candidate_count: number;
  candidates: Array<{
    candidate_id: string;
    source: 'job' | 'lead';
    job_id: string | null;
    lead_id: string | null;
    customer_id: string | null;
    address_id: string | null;
    address_line: string | null;
    category: string | null;
    summary: string;
    blurb: string;
    score: number;
    last_interaction_at: string;
  }>;
};

async function executeMemoryFetchCandidates(
  input: MemoryFetchCandidatesInput,
): Promise<MemoryFetchCandidatesResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
    select: { id: true, customerId: true },
  });

  if (!lead) {
    throw new Error('Lead not found for memory lookup.');
  }

  if (!lead.customerId) {
    return { lead_id: lead.id, candidate_count: 0, candidates: [] };
  }

  const candidates = await fetchContextCandidates(
    lead.customerId,
    input.query_text,
    input.k,
  );

  return {
    lead_id: lead.id,
    candidate_count: candidates.length,
    candidates: candidates.map(toMemoryCandidateResult),
  };
}

function toMemoryCandidateResult(candidate: ContextCandidate) {
  return {
    candidate_id: candidate.id,
    source: candidate.source,
    job_id: candidate.jobId ?? null,
    lead_id: candidate.leadId ?? null,
    customer_id: candidate.customerId ?? null,
    address_id: candidate.addressId ?? null,
    address_line: candidate.addressLine ?? null,
    category: candidate.category ?? null,
    summary: candidate.summary,
    blurb: buildCandidateBlurb(candidate),
    score: candidate.score,
    last_interaction_at: candidate.lastInteractionAt.toISOString(),
  };
}

function buildCandidateBlurb(candidate: ContextCandidate): string {
  const date = formatDate(candidate.lastInteractionAt);
  const address = candidate.addressLine ?? 'address pending';
  return `${date} · ${address} · score ${candidate.score.toFixed(2)}`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

const memoryFetchCandidatesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier tied to the current conversation.',
    },
    query_text: {
      type: 'string',
      description: 'Latest user utterance used to score prior jobs/leads.',
    },
    k: {
      anyOf: [
        {
          type: 'integer',
          minimum: 1,
          maximum: 10,
        },
        { type: 'null' },
      ],
      default: null,
      description: 'Optional number of candidates to return (1-10).',
    },
  },
  required: ['lead_id', 'query_text', 'k'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildMemoryFetchCandidatesTool() {
  return tool({
    name: 'memory_fetch_candidates',
    description:
      'Retrieves recent jobs or leads for this customer so you can confirm the correct address/context.',
    parameters: memoryFetchCandidatesJsonSchema,
    execute: async (args) =>
      executeMemoryFetchCandidates(
        memoryFetchCandidatesParameters.parse({
          k: null,
          ...args,
        }),
      ),
  });
}
