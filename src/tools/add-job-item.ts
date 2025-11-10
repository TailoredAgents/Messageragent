import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';

const addJobItemParameters = z
  .object({
    job_id: z.string().uuid('job_id must be a valid UUID'),
    kind: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(120)),
    quantity: z.number().positive('quantity must be positive'),
    unit: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(40))
      .nullish(),
    unit_price_amount: z.number().min(0).nullish(),
    total_amount: z.number().min(0).nullish(),
    notes: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(500))
      .nullish(),
  })
  .transform((input) => ({
    ...input,
    unit: normalizeNullable(input.unit),
    notes: normalizeNullable(input.notes),
  }));

type AddJobItemInput = z.infer<typeof addJobItemParameters>;

type AddJobItemResult = {
  job_id: string;
  job_item_id: string;
  description: string;
  total_amount: number;
  currency: string;
  blurb: string;
};

async function executeAddJobItem(input: AddJobItemInput): Promise<AddJobItemResult> {
  const job = await prisma.job.findUnique({
    where: { id: input.job_id },
  });
  if (!job) {
    throw new Error('Job not found for job item.');
  }

  const unitPrice = new Prisma.Decimal(input.unit_price_amount ?? 0);
  const total =
    typeof input.total_amount === 'number'
      ? new Prisma.Decimal(input.total_amount)
      : unitPrice.mul(input.quantity);

  const jobItem = await prisma.jobItem.create({
    data: {
      jobId: job.id,
      description: input.kind,
      quantity: new Prisma.Decimal(input.quantity),
      unitPrice,
      total,
      metadata: {
        unit: input.unit ?? null,
        notes: input.notes ?? null,
      } as Prisma.JsonObject,
    },
  });

  return {
    job_id: job.id,
    job_item_id: jobItem.id,
    description: jobItem.description,
    total_amount: Number(jobItem.total.toNumber()),
    currency: 'USD',
    blurb: buildJobItemBlurb(jobItem.description, jobItem.total.toNumber(), input.unit),
  };
}

function normalizeNullable(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildJobItemBlurb(description: string, total: number, unit?: string): string {
  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(total);
  return unit ? `${description} (${unit}) · ${currency}` : `${description} · ${currency}`;
}

const addJobItemJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    job_id: {
      type: 'string',
      description: 'Job identifier that the line item belongs to.',
    },
    kind: {
      type: 'string',
      description: 'Human-readable description (e.g., "Full trailer").',
    },
    quantity: {
      type: 'number',
      description: 'Quantity for this item.',
    },
    unit: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Optional unit (load, cubic_yd, hour, etc.).',
    },
    unit_price_amount: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      default: null,
      description: 'Optional unit price to compute totals.',
    },
    total_amount: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      default: null,
      description: 'Override for total amount. Defaults to quantity × unit price.',
    },
    notes: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Optional internal notes about the item.',
    },
  },
  required: [
    'job_id',
    'kind',
    'quantity',
    'unit',
    'unit_price_amount',
    'total_amount',
    'notes',
  ],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildAddJobItemTool() {
  return tool({
    name: 'add_job_item',
    description:
      'Adds a priced line item to a job so downstream scheduling and invoicing have structured details.',
    parameters: addJobItemJsonSchema,
    execute: async (args) =>
      executeAddJobItem(
        addJobItemParameters.parse({
          unit: null,
          unit_price_amount: null,
          total_amount: null,
          notes: null,
          ...args,
        }),
      ),
  });
}
