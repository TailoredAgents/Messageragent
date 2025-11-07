import { randomUUID } from 'node:crypto';

import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';
import { computeQuote } from '../lib/price-engine.ts';
import { loadTenantConfig } from '../lib/config.ts';
import { QuoteComputation, VisionFeatureSummary } from '../lib/types.ts';
import { hashJson } from '../lib/hash.ts';

export const visionFeaturesSchema = z.object({
  volume_class: z.string(),
  cubic_yards_est: z.number().min(0),
  bedload: z.boolean(),
  bedload_type: z.string().nullable(),
  heavy_items: z.array(z.string()).default([]),
  stairs_flights: z.number().int().min(0),
  carry_distance_ft: z.number().int().min(0),
  curbside: z.boolean(),
  hazards: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

const priceFromRulesParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    features: visionFeaturesSchema,
    notes: z.array(z.string()).nullish(),
  })
  .transform((data) => ({
    ...data,
    notes: data.notes ?? undefined,
  }));

export type PriceFromRulesInput = z.infer<typeof priceFromRulesParameters>;

type PriceFromRulesResult = QuoteComputation & {
  quote_id: string;
  needs_approval: boolean;
  approval_token?: string;
  disclaimer: string | null;
};

type PriceFromRulesOptions = {
  trigger?: 'agent' | 'automation';
  featuresHash?: string;
};

async function resolveConfig() {
  const fileConfig = await loadTenantConfig();
  const dbConfig = await prisma.config.findFirst({
    where: { tenantId: fileConfig.tenant },
  });

  return {
    tenant: fileConfig.tenant,
    service_area: (dbConfig?.serviceArea ??
      fileConfig.service_area) as unknown as Parameters<typeof computeQuote>[0]['serviceArea'],
    pricebook: (dbConfig?.pricebook ??
      fileConfig.pricebook) as unknown as Parameters<typeof computeQuote>[0]['pricebook'],
    quote_policy: (dbConfig?.quotePolicy ??
      fileConfig.quote_policy) as unknown as Parameters<typeof computeQuote>[0]['quotePolicy'],
  };
}

export async function runPriceFromRules(
  input: PriceFromRulesInput,
  options: PriceFromRulesOptions = {},
): Promise<PriceFromRulesResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
  });

  if (!lead) {
    throw new Error('Lead not found.');
  }

  const config = await resolveConfig();

  const quoteComputation = computeQuote({
    features: input.features as VisionFeatureSummary,
    pricebook: config.pricebook,
    serviceArea: config.service_area,
    quotePolicy: config.quote_policy,
    lead: {
      curbside: lead.curbside,
      lat: lead.lat,
      lng: lead.lng,
      address: lead.address,
    },
  });

  const needsApproval =
    quoteComputation.flags.needs_approval ||
    quoteComputation.flags.low_confidence;

  const combinedNotes = [
    ...quoteComputation.notes,
    ...(input.notes ?? []),
  ];

  const featuresHash = hashJson(input.features);

  const quote = await prisma.quote.create({
    data: {
      leadId: lead.id,
      featuresJson: input.features as unknown as Prisma.JsonValue,
      lineItemsJson: quoteComputation.line_items as Prisma.JsonValue,
      discountsJson: quoteComputation.discounts as Prisma.JsonValue,
      subtotal: new Prisma.Decimal(quoteComputation.subtotal),
      total: new Prisma.Decimal(quoteComputation.total),
      confidence: new Prisma.Decimal(input.features.confidence),
      needsApproval,
      status: needsApproval ? 'pending_approval' : 'draft',
      flagsJson: quoteComputation.flags as Prisma.JsonValue,
      notesJson: combinedNotes as Prisma.JsonValue,
      disclaimer: config.quote_policy.disclaimer,
    },
  });

  const metadata =
    ((lead.stateMetadata as Prisma.JsonObject | null) ?? {}) as Record<
      string,
      unknown
    >;
  const previousPricedHash =
    typeof metadata.last_priced_features_hash === 'string'
      ? (metadata.last_priced_features_hash as string)
      : undefined;

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: needsApproval ? 'awaiting_owner' : 'quoting',
      stateMetadata: {
        ...metadata,
        last_quote_id: quote.id,
        last_quote_at: new Date().toISOString(),
        quote_flags: quoteComputation.flags,
        last_priced_features_hash:
          options.featuresHash ?? featuresHash ?? previousPricedHash,
      },
    },
  });

  let approvalToken: string | undefined;

  if (needsApproval) {
    approvalToken = randomUUID();
    await prisma.approval.create({
      data: {
        quoteId: quote.id,
        token: approvalToken,
        status: 'pending',
      },
    });
  }

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'agent',
      action: 'price_from_rules',
      payload: {
        quote_id: quote.id,
        needs_approval: needsApproval,
        totals: quoteComputation.total,
        trigger: options.trigger ?? 'agent',
      } as Prisma.JsonObject,
    },
  });

  return {
    ...quoteComputation,
    notes: combinedNotes,
    quote_id: quote.id,
    needs_approval: needsApproval,
    approval_token: approvalToken,
    disclaimer: config.quote_policy.disclaimer,
  };
}

const priceFromRulesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier to evaluate pricing for.',
    },
    features: {
      type: 'object',
      additionalProperties: false,
      description: 'Structured vision features describing the junk load.',
      properties: {
        volume_class: {
          type: 'string',
          description: 'Qualitative volume bucket (e.g., quarter load).',
        },
        cubic_yards_est: {
          type: 'number',
          minimum: 0,
          description: 'Estimated volume in cubic yards.',
        },
        bedload: {
          type: 'boolean',
          description: 'Whether the load is primarily loose material.',
        },
        bedload_type: {
          description: 'Specific bedload material if applicable.',
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
        },
        heavy_items: {
          type: 'array',
          description: 'List of heavy or regulated items detected.',
          items: { type: 'string' },
          default: [],
        },
        stairs_flights: {
          type: 'integer',
          minimum: 0,
          description: 'Number of stair flights to move items.',
        },
        carry_distance_ft: {
          type: 'integer',
          minimum: 0,
          description: 'Carry distance from curb in feet.',
        },
        curbside: {
          type: 'boolean',
          description: 'Whether items are staged curbside.',
        },
        hazards: {
          type: 'array',
          description: 'Safety hazards present in the images.',
          items: { type: 'string' },
          default: [],
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Vision model confidence from 0-1.',
        },
      },
      required: [
        'volume_class',
        'cubic_yards_est',
        'bedload',
        'bedload_type',
        'heavy_items',
        'stairs_flights',
        'carry_distance_ft',
        'curbside',
        'hazards',
        'confidence',
      ],
    },
    notes: {
      description: 'Additional operator notes to include on the quote.',
      anyOf: [
        {
          type: 'array',
          items: { type: 'string' },
        },
        { type: 'null' },
      ],
      default: null,
    },
  },
  required: ['lead_id', 'features', 'notes'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildPriceFromRulesTool() {
  return tool({
    name: 'price_from_rules',
    description:
      'Apply pricebook rules to structured features and create a persisted quote.',
    parameters: priceFromRulesJsonSchema,
    execute: async (args) =>
      runPriceFromRules(
        priceFromRulesParameters.parse({
          notes: null,
          ...args,
        }),
        { trigger: 'agent' },
      ),
  });
}
