import { Prisma } from '@prisma/client';

import { prisma } from './prisma.ts';
import { VisionFeatureSummary } from './types.ts';
import {
  runPriceFromRules,
  visionFeaturesSchema,
} from '../tools/price-from-rules.ts';

type AutoQuoteResult = {
  triggered: boolean;
};

function parseVisionFeatures(value: unknown): VisionFeatureSummary | undefined {
  const result = visionFeaturesSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

export async function maybeRunAutoQuote(leadId: string): Promise<AutoQuoteResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
  });
  if (!lead) {
    return { triggered: false };
  }

  const metadata =
    ((lead.stateMetadata as Prisma.JsonObject | null) ?? {}) as Record<
      string,
      unknown
    >;

  const features = parseVisionFeatures(metadata.last_features);
  const featuresHash =
    typeof metadata.last_features_hash === 'string'
      ? (metadata.last_features_hash as string)
      : undefined;
  const lastPricedHash =
    typeof metadata.last_priced_features_hash === 'string'
      ? (metadata.last_priced_features_hash as string)
      : undefined;

  if (!features || !featuresHash || featuresHash === lastPricedHash) {
    return { triggered: false };
  }

  await runPriceFromRules(
    {
      lead_id: lead.id,
      features,
      notes: [],
    },
    { trigger: 'automation', featuresHash },
  );

  return { triggered: true };
}
