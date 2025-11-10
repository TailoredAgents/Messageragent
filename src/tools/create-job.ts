import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';

const JOB_WINDOW_FALLBACK_HOURS = 2;

const createJobParameters = z
  .object({
    customer_id: z.string().uuid('customer_id must be a valid UUID'),
    lead_id: z.string().uuid().nullish(),
    address_id: z.string().uuid().nullish(),
    title: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(3).max(120)),
    description: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(5).max(2000)),
    category: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(80))
      .nullish(),
    price_amount: z.number().min(0).nullish(),
    price_currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(
        z
          .string()
          .length(3, 'price_currency must be a 3-letter ISO code')
          .regex(/^[A-Z]+$/, 'price_currency must be alphabetical'),
      )
      .nullish(),
    scheduled_date: z
      .string()
      .datetime({ offset: true })
      .nullish(),
  })
  .transform((input) => ({
    ...input,
    lead_id: input.lead_id ?? undefined,
    address_id: input.address_id ?? undefined,
    category: normalizeNullable(input.category),
    price_currency: input.price_currency ?? 'USD',
    scheduled_date: input.scheduled_date ?? undefined,
  }));

type CreateJobInput = z.infer<typeof createJobParameters>;

type CreateJobResult = {
  job_id: string;
  lead_id: string;
  customer_id: string;
  status: string;
  window_start: string;
  window_end: string;
  blurb: string;
};

async function executeCreateJob(input: CreateJobInput): Promise<CreateJobResult> {
  const customer = await prisma.customer.findUnique({
    where: { id: input.customer_id },
    select: { id: true, name: true, phone: true, email: true },
  });

  if (!customer) {
    throw new Error('Customer not found for job creation.');
  }

  const lead = await resolveLead(customer, input.lead_id);
  const addressLine = await resolveAddressLine(customer.id, input.address_id);

  const windowStart = buildWindowStart(input.scheduled_date);
  const windowEnd = new Date(windowStart.getTime() + JOB_WINDOW_FALLBACK_HOURS * 60 * 60 * 1000);

  let job = await prisma.job.findFirst({
    where: {
      leadId: lead.id,
      windowStart,
    },
  });

  if (job) {
    job = await prisma.job.update({
      where: { id: job.id },
      data: {
        customerId: customer.id,
        windowEnd,
        status: job.status ?? 'tentative',
      },
    });
  } else {
    job = await prisma.job.create({
      data: {
        leadId: lead.id,
        customerId: customer.id,
        windowStart,
        windowEnd,
        status: 'tentative',
      },
    });
  }

  await prisma.jobEvent.create({
    data: {
      jobId: job.id,
      eventType: 'job_created',
      metadata: {
        title: input.title,
        description: input.description,
        category: input.category ?? null,
        price_amount: input.price_amount ?? null,
        price_currency: input.price_currency,
        scheduled_date: windowStart.toISOString(),
        address_line: addressLine ?? null,
      } as Prisma.JsonObject,
    },
  });

  if (addressLine && !lead.address) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { address: addressLine },
    });
  }

  return {
    job_id: job.id,
    lead_id: job.leadId,
    customer_id: job.customerId,
    status: job.status,
    window_start: job.windowStart.toISOString(),
    window_end: job.windowEnd.toISOString(),
    blurb: buildJobBlurb(windowStart, addressLine, input.price_amount, input.price_currency),
  };
}

async function resolveLead(
  customer: { id: string; name: string | null; phone: string | null; email: string | null },
  explicitLeadId?: string,
) {
  if (explicitLeadId) {
    const existing = await prisma.lead.findUnique({ where: { id: explicitLeadId } });
    if (!existing) {
      throw new Error('Explicit lead_id not found.');
    }
    if (existing.customerId !== customer.id) {
      await prisma.lead.update({
        where: { id: existing.id },
        data: { customerId: customer.id },
      });
    }
    return existing;
  }

  const latestLead = await prisma.lead.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: 'desc' },
  });

  if (latestLead) {
    return latestLead;
  }

  return prisma.lead.create({
    data: {
      customerId: customer.id,
      channel: 'messenger',
      name: customer.name ?? undefined,
      phone: customer.phone ?? undefined,
      email: customer.email ?? undefined,
      stage: 'scheduling',
    },
  });
}

async function resolveAddressLine(
  customerId: string,
  addressId?: string,
): Promise<string | null> {
  if (!addressId) {
    return null;
  }
  const address = await prisma.customerAddress.findUnique({
    where: { id: addressId },
  });
  if (!address || address.customerId !== customerId) {
    throw new Error('address_id is not associated with this customer.');
  }
  return [address.address, address.city, address.state, address.zip]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

function buildWindowStart(dateInput?: string): Date {
  if (!dateInput) {
    return new Date();
  }
  const date = new Date(dateInput);
  if (Number.isNaN(date.valueOf())) {
    throw new Error('scheduled_date must be an ISO-8601 string.');
  }
  return date;
}

function buildJobBlurb(
  windowStart: Date,
  addressLine: string | null,
  priceAmount?: number,
  priceCurrency?: string,
): string {
  const formattedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(windowStart);
  const parts = [formattedDate, addressLine ?? 'address pending'];
  if (typeof priceAmount === 'number') {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: priceCurrency ?? 'USD',
      maximumFractionDigits: 2,
    });
    parts.push(formatter.format(priceAmount));
  }
  return parts.join(' · ');
}

function normalizeNullable(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const createJobJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customer_id: {
      type: 'string',
      description: 'Customer identifier that the job belongs to.',
    },
    lead_id: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description:
        'Optional lead identifier. When omitted, the latest lead for the customer is reused or a stub lead is created.',
    },
    address_id: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Optional saved address identifier for the job.',
    },
    title: {
      type: 'string',
      description: 'Short label for the job (shown in UI summaries).',
    },
    description: {
      type: 'string',
      description: 'Long-form description of the work.',
    },
    category: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Optional category tag (garage, curbside, etc.).',
    },
    price_amount: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      default: null,
      description: 'Optional quoted job price in price_currency.',
    },
    price_currency: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'ISO currency code. Defaults to USD.',
    },
    scheduled_date: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'ISO-8601 datetime for the tentative pickup window start.',
    },
  },
  required: [
    'customer_id',
    'lead_id',
    'address_id',
    'title',
    'description',
    'category',
    'price_amount',
    'price_currency',
    'scheduled_date',
  ],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildCreateJobTool() {
  return tool({
    name: 'create_job',
    description:
      'Creates or updates a tentative job for the customer, storing metadata for later scheduling.',
    parameters: createJobJsonSchema,
    execute: async (args) =>
      executeCreateJob(
        createJobParameters.parse({
          lead_id: null,
          address_id: null,
          category: null,
          price_amount: null,
          price_currency: null,
          scheduled_date: null,
          ...args,
        }),
      ),
  });
}
