import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';

const recordJobEventParameters = z
  .object({
    job_id: z.string().uuid('job_id must be a valid UUID'),
    type: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(64)),
    payload: z
      .string()
      .transform((value) => value.trim())
      .nullish(),
  })
  .transform((input) => ({
    ...input,
    payload: parsePayload(input.payload),
  }));

type RecordJobEventInput = z.infer<typeof recordJobEventParameters>;

type RecordJobEventResult = {
  event_id: string;
  job_id: string;
  type: string;
  created_at: string;
};

export async function recordJobEvent(
  input: RecordJobEventInput,
): Promise<RecordJobEventResult> {
  const job = await prisma.job.findUnique({
    where: { id: input.job_id },
    select: { id: true },
  });

  if (!job) {
    throw new Error('Job not found for job event.');
  }

  const event = await prisma.jobEvent.create({
    data: {
      jobId: job.id,
      eventType: input.type,
      metadata: (input.payload ?? null) as Prisma.JsonObject | null,
    },
  });

  return {
    event_id: event.id,
    job_id: job.id,
    type: event.eventType,
    created_at: event.createdAt.toISOString(),
  };
}

const recordJobEventJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    job_id: {
      type: 'string',
      description: 'Job identifier the event applies to.',
    },
    type: {
      type: 'string',
      description: 'Short event label (e.g., quoted, scheduled, reminder_sent).',
    },
    payload: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description:
        'Optional JSON string payload. Example: {"context":"prior_job","basis":"confirmed"}.',
    },
  },
  required: ['job_id', 'type', 'payload'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildRecordJobEventTool() {
  return tool({
    name: 'record_job_event',
    description:
      'Stores a structured job event so downstream systems can audit quoting and scheduling changes.',
    parameters: recordJobEventJsonSchema,
    execute: async (args) =>
      recordJobEvent(
        recordJobEventParameters.parse({
          payload: null,
          ...args,
        }),
      ),
  });
}

function parsePayload(raw: string | null | undefined): Prisma.JsonObject | null | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Prisma.JsonObject;
    }
    return undefined;
  } catch (error) {
    throw new Error('payload must be valid JSON when provided.');
  }
}
