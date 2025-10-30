import { randomUUID } from 'node:crypto';

import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';
import { computeQuote } from '../lib/price-engine.ts';
import { loadTenantConfig } from '../lib/config.ts';
import { QuoteComputation, VisionFeatureSummary } from '../lib/types.ts';

const featuresSchema = z.object({
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

const priceFromRulesParameters = z.object({
  lead_id: z.string().uuid('lead_id must be a valid UUID'),
  features: featuresSchema,
  notes: z.array(z.string()).optional(),
});

type PriceFromRulesInput = z.infer<typeof priceFromRulesParameters>;

type PriceFromRulesResult = QuoteComputation & {
  quote_id: string;
  needs_approval: boolean;
  approval_token?: string;
  disclaimer: string | null;
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

async function priceFromRules(
  input: PriceFromRulesInput,
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

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: needsApproval ? 'awaiting_owner' : 'quoting',
      stateMetadata: {
        ...((lead.stateMetadata as Prisma.JsonObject) ?? {}),
        last_quote_id: quote.id,
        last_quote_at: new Date().toISOString(),
        quote_flags: quoteComputation.flags,
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

export function buildPriceFromRulesTool() {
  return tool({
    name: 'price_from_rules',
    description:
      'Apply pricebook rules to structured features and create a persisted quote.',
    parameters: priceFromRulesParameters,
    execute: priceFromRules,
  });
}
