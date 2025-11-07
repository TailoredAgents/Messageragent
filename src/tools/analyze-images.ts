import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { getOpenAIClient } from '../lib/openai.ts';
import { prisma } from '../lib/prisma.ts';
import { VisionFeatureSummary } from '../lib/types.ts';

const ANALYZE_MODEL_PRIMARY = process.env.ANALYZE_MODEL_PRIMARY ?? 'gpt-5-mini';
const ANALYZE_MODEL_ESCALATION =
  process.env.ANALYZE_MODEL_ESCALATION ?? 'gpt-5';

const analyzeImagesParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    images: z
      .array(z.string().url('image URLs must be valid HTTPS URLs'))
      .min(1),
    notes: z.string().max(500).nullish(),
  })
  .transform((data) => ({
    ...data,
    notes: data.notes ?? undefined,
  }));

type AnalyzeImagesInput = z.infer<typeof analyzeImagesParameters>;

type AnalyzeImagesResponse = VisionFeatureSummary & {
  escalated_model?: string;
};

const featureSchema = {
  name: 'vision_features',
  schema: {
    type: 'object',
    properties: {
      volume_class: { type: 'string' },
      cubic_yards_est: { type: 'number' },
      bedload: { type: 'boolean' },
      bedload_type: { type: ['string', 'null'] },
      heavy_items: {
        type: 'array',
        items: { type: 'string' },
        default: [],
      },
      stairs_flights: { type: 'integer', minimum: 0 },
      carry_distance_ft: { type: 'integer', minimum: 0 },
      curbside: { type: 'boolean', default: false },
      hazards: {
        type: 'array',
        items: { type: 'string' },
        default: [],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
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
    additionalProperties: false,
  },
  strict: true,
} as const;

async function callVisionModel(
  model: string,
  input: AnalyzeImagesInput,
): Promise<VisionFeatureSummary> {
  const client = getOpenAIClient();

  const response = await client.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You are a junk removal estimator. Describe the load characteristics precisely. ' +
              'Return cubic yards, hazards, stairs, long carry distance, heavy or regulated items, and curbside status.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: input.notes
              ? `Customer shared context: ${input.notes}`
              : 'Analyze these photos for junk removal quoting.',
          },
          ...input.images.map((url) => ({
            type: 'input_image' as const,
            image_url: url,
          })),
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: featureSchema,
    },
  });

  const jsonContent = response.output?.[0]?.content?.find(
    (item) => item.type === 'output_json',
  );

  if (!jsonContent || jsonContent.type !== 'output_json') {
    throw new Error('Vision model response missing structured output.');
  }

  const parsed = JSON.parse(jsonContent.json) as VisionFeatureSummary;
  return {
    volume_class: parsed.volume_class,
    cubic_yards_est: Number(parsed.cubic_yards_est),
    bedload: Boolean(parsed.bedload),
    bedload_type: parsed.bedload_type,
    heavy_items: parsed.heavy_items ?? [],
    stairs_flights: Number(parsed.stairs_flights ?? 0),
    carry_distance_ft: Number(parsed.carry_distance_ft ?? 0),
    curbside: Boolean(parsed.curbside),
    hazards: parsed.hazards ?? [],
    confidence: Number(parsed.confidence),
  };
}

async function analyzeImages(
  input: AnalyzeImagesInput,
): Promise<AnalyzeImagesResponse> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
  });
  if (!lead) {
    throw new Error('Lead not found.');
  }

  const previousMetadata =
    (lead.stateMetadata as Prisma.JsonObject | null) ?? {};

  let result = await callVisionModel(ANALYZE_MODEL_PRIMARY, input);
  let escalatedModel: string | undefined;

  const needsEscalation =
    result.confidence < 0.7 ||
    result.hazards.length > 0 ||
    result.heavy_items.length > 3;

  if (needsEscalation) {
    try {
      const escalated = await callVisionModel(ANALYZE_MODEL_ESCALATION, input);
      // Prefer escalated result if it increases confidence.
      if (escalated.confidence >= result.confidence) {
        result = escalated;
        escalatedModel = ANALYZE_MODEL_ESCALATION;
      }
    } catch (error) {
      console.warn('Vision escalation failed, falling back to primary.', error);
    }
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: 'clarifying',
      stateMetadata: {
        ...previousMetadata,
        last_analyzed_at: new Date().toISOString(),
        last_features: result,
      },
    },
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'agent',
      action: 'analyze_images',
      payload: {
        image_count: input.images.length,
        escalated_model: escalatedModel,
        confidence: result.confidence,
      } as Prisma.JsonObject,
    },
  });

  return {
    ...result,
    escalated_model: escalatedModel,
  };
}

const analyzeImagesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier tied to the images being analyzed.',
    },
    images: {
      type: 'array',
      description: 'HTTPS image URLs to evaluate.',
      items: {
        type: 'string',
        pattern: '^https://.+',
      },
      minItems: 1,
    },
    notes: {
      description: 'Optional operator notes or extra context.',
      anyOf: [
        {
          type: 'string',
          maxLength: 500,
        },
        { type: 'null' },
      ],
      default: null,
    },
  },
  required: ['lead_id', 'images'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildAnalyzeImagesTool() {
  return tool({
    name: 'analyze_images',
    description:
      'Analyze junk removal photos and return structured load features for pricing decisions.',
    parameters: analyzeImagesJsonSchema,
    execute: async (args) =>
      analyzeImages(
        analyzeImagesParameters.parse({
          notes: null,
          ...args,
        }),
      ),
  });
}
