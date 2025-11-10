import { tool } from '@openai/agents';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';

const addAddressParameters = z
  .object({
    customer_id: z.string().uuid('customer_id must be a valid UUID'),
    address: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(5, 'address must be at least 5 characters')),
    city: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(120))
      .nullish(),
    state: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(50))
      .nullish(),
    postal_code: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(3).max(20))
      .nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    is_primary: z.boolean().nullish(),
  })
  .transform((input) => ({
    ...input,
    city: normalizeNullable(input.city),
    state: normalizeNullable(input.state),
    postal_code: normalizeNullable(input.postal_code),
    latitude: typeof input.latitude === 'number' ? input.latitude : undefined,
    longitude: typeof input.longitude === 'number' ? input.longitude : undefined,
    is_primary: input.is_primary ?? undefined,
  }));

type AddAddressInput = z.infer<typeof addAddressParameters>;

type AddAddressResult = {
  customer_id: string;
  address_id: string;
  address: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  is_primary: boolean;
  blurb: string;
};

async function executeAddAddress(input: AddAddressInput): Promise<AddAddressResult> {
  const customer = await prisma.customer.findUnique({
    where: { id: input.customer_id },
  });

  if (!customer) {
    throw new Error('Customer not found for address creation.');
  }

  const matchingAddress = await prisma.customerAddress.findFirst({
    where: {
      customerId: customer.id,
      address: input.address,
      city: input.city ?? undefined,
      state: input.state ?? undefined,
      zip: input.postal_code ?? undefined,
    },
  });

  let addressRecord =
    matchingAddress ??
    (await prisma.customerAddress.create({
      data: {
        customerId: customer.id,
        address: input.address,
        city: input.city ?? undefined,
        state: input.state ?? undefined,
        zip: input.postal_code ?? undefined,
        lat: input.latitude,
        lng: input.longitude,
        isPrimary: input.is_primary ?? false,
      },
    }));

  if (matchingAddress) {
    addressRecord = await prisma.customerAddress.update({
      where: { id: matchingAddress.id },
      data: {
        address: input.address,
        city: input.city ?? undefined,
        state: input.state ?? undefined,
        zip: input.postal_code ?? undefined,
        lat: input.latitude,
        lng: input.longitude,
        ...(typeof input.is_primary === 'boolean' ? { isPrimary: input.is_primary } : {}),
      },
    });
  }

  if (input.is_primary) {
    await prisma.customerAddress.updateMany({
      where: {
        customerId: customer.id,
        NOT: { id: addressRecord.id },
      },
      data: { isPrimary: false },
    });
  }

  return {
    customer_id: customer.id,
    address_id: addressRecord.id,
    address: addressRecord.address,
    city: addressRecord.city ?? null,
    state: addressRecord.state ?? null,
    postal_code: addressRecord.zip ?? null,
    is_primary: addressRecord.isPrimary,
    blurb: buildAddressBlurb(addressRecord),
  };
}

function normalizeNullable(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAddressBlurb(address: {
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string {
  return [address.address, address.city, address.state, address.zip]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

const addAddressJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customer_id: {
      type: 'string',
      description: 'Customer identifier that will own the address.',
    },
    address: {
      type: 'string',
      description: 'Street address (line 1).',
    },
    city: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'City or locality.',
    },
    state: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'State / province abbreviation.',
    },
    postal_code: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'ZIP or postal code.',
    },
    latitude: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      default: null,
      description: 'Optional latitude for the address.',
    },
    longitude: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      default: null,
      description: 'Optional longitude for the address.',
    },
    is_primary: {
      anyOf: [{ type: 'boolean' }, { type: 'null' }],
      default: null,
      description: 'Whether this address should be marked as primary.',
    },
  },
  required: [
    'customer_id',
    'address',
    'city',
    'state',
    'postal_code',
    'latitude',
    'longitude',
    'is_primary',
  ],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildAddAddressTool() {
  return tool({
    name: 'add_address',
    description: 'Adds or updates a saved service address for a customer.',
    parameters: addAddressJsonSchema,
    execute: async (args) =>
      executeAddAddress(
        addAddressParameters.parse({
          city: null,
          state: null,
          postal_code: null,
          latitude: null,
          longitude: null,
          is_primary: null,
          ...args,
        }),
      ),
  });
}
