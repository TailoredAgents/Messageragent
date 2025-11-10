import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';

const upsertCustomerProfileParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(120))
      .nullish(),
    phone: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(7, 'phone must have at least 7 digits')
          .max(30, 'phone is too long'),
      )
      .nullish(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('email must be valid')
      .nullish(),
  })
  .refine(
    (value) => Boolean(value.name ?? value.phone ?? value.email),
    'Provide at least one of name, phone, or email.',
  )
  .transform((input) => ({
    ...input,
    name: normalizeNullable(input.name),
    phone: normalizeNullable(input.phone),
    email: normalizeNullable(input.email),
  }));

type UpsertCustomerProfileInput = z.infer<typeof upsertCustomerProfileParameters>;

type UpsertCustomerProfileResult = {
  customer_id: string;
  lead_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  blurb: string;
};

async function executeUpsertCustomerProfile(
  input: UpsertCustomerProfileInput,
): Promise<UpsertCustomerProfileResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
    include: { customer: true },
  });

  if (!lead) {
    throw new Error('Lead not found for customer profile update.');
  }

  let customer = lead.customer;
  if (!customer) {
    customer = await findReusableCustomer(input) ?? null;
  }

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: input.name ?? lead.name ?? undefined,
        phone: input.phone ?? lead.phone ?? undefined,
        email: input.email ?? lead.email ?? undefined,
      },
    });
  }

  const customerUpdates: Prisma.CustomerUpdateInput = {};
  if (input.name && input.name !== customer.name) {
    customerUpdates.name = input.name;
  }
  if (input.phone && input.phone !== customer.phone) {
    customerUpdates.phone = input.phone;
  }
  if (input.email && input.email !== customer.email) {
    customerUpdates.email = input.email;
  }

  if (Object.keys(customerUpdates).length > 0) {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: customerUpdates,
    });
  }

  const leadUpdates: Prisma.LeadUpdateInput = {
    customer: { connect: { id: customer.id } },
  };
  if (input.name) {
    leadUpdates.name = input.name;
  }
  if (input.phone) {
    leadUpdates.phone = input.phone;
  }
  if (input.email) {
    leadUpdates.email = input.email;
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: leadUpdates,
  });

  return {
    customer_id: customer.id,
    lead_id: lead.id,
    name: customer.name ?? null,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    blurb: buildCustomerBlurb(customer),
  };
}

async function findReusableCustomer(input: UpsertCustomerProfileInput) {
  if (input.phone) {
    const existing = await prisma.customer.findFirst({
      where: { phone: input.phone },
    });
    if (existing) {
      return existing;
    }
  }
  if (input.email) {
    return prisma.customer.findFirst({
      where: { email: input.email },
    });
  }
  return null;
}

function normalizeNullable(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildCustomerBlurb(customer: {
  name: string | null;
  phone: string | null;
  email: string | null;
}): string {
  return [customer.name, customer.phone, customer.email]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

const upsertCustomerProfileJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier associated with the customer profile.',
    },
    name: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Updated customer name.',
    },
    phone: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Customer phone number (E.164 preferred).',
    },
    email: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Customer email address.',
    },
  },
  required: ['lead_id', 'name', 'phone', 'email'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildUpsertCustomerProfileTool() {
  return tool({
    name: 'upsert_customer_profile',
    description:
      'Writes customer contact info (name, phone, email) and links the active lead to that customer record.',
    parameters: upsertCustomerProfileJsonSchema,
    execute: async (args) =>
      executeUpsertCustomerProfile(
        upsertCustomerProfileParameters.parse({
          name: null,
          phone: null,
          email: null,
          ...args,
        }),
      ),
  });
}
