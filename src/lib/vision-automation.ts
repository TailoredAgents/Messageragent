import type { Lead } from '@prisma/client';

import { hashStrings } from './hash.ts';
import { ensurePublicImageUrls } from './image-cache.ts';
import { runVisionAnalysis } from '../tools/analyze-images.ts';
import { maybeRunAutoQuote } from './pricing-automation.ts';

type VisionAutomationParams = {
  lead: Lead;
  attachments: string[];
  channel: 'messenger' | 'sms';
};

export async function maybeRunVisionAutomation({
  lead,
  attachments,
  channel,
}: VisionAutomationParams): Promise<{ triggered: boolean }> {
  const toggle = String(process.env.ENABLE_AUTO_ANALYSIS ?? 'true')
    .toLowerCase()
    .trim();
  if (['0', 'false', 'no', 'off'].includes(toggle)) {
    console.info('[AutoAnalysis] Disabled via ENABLE_AUTO_ANALYSIS');
    return { triggered: false };
  }
  if (attachments.length === 0) {
    return { triggered: false };
  }

  const normalized = attachments.filter((url) => typeof url === 'string' && url.length > 0);
  if (normalized.length === 0) {
    return { triggered: false };
  }

  // Rehost images so OpenAI can fetch reliably from a stable HTTPS origin.
  let publicUrls = normalized;
  try {
    publicUrls = await ensurePublicImageUrls(normalized);
  } catch (e) {
    console.warn('[AutoAnalysis] Failed to rehost images, using originals', e);
  }

  const attachmentHash = hashStrings(publicUrls);
  const metadata =
    ((lead.stateMetadata as Record<string, unknown> | null) ?? {}) as Record<
      string,
      unknown
    >;
  const previousHash =
    typeof metadata.last_analyzed_hash === 'string'
      ? (metadata.last_analyzed_hash as string)
      : undefined;

  if (attachmentHash === previousHash) {
    console.info('[AutoAnalysis] Duplicate attachment hash — skipped', {
      leadId: lead.id,
      hash: attachmentHash,
      count: normalized.length,
    });
    return { triggered: false };
  }

  try {
    await runVisionAnalysis(
      {
        lead_id: lead.id,
        images: publicUrls,
        notes: `${channel.toUpperCase()} auto-analysis of ${normalized.length} photo(s).`,
      },
      {
        trigger: 'automation',
        attachmentHash,
      },
    );
    await maybeRunAutoQuote(lead.id);
    return { triggered: true };
  } catch (error) {
    console.error('Auto vision analysis failed', {
      leadId: lead.id,
      channel,
      error,
    });
    // Cache the hash on failure to avoid retry loops on the same photos.
    try {
      const prev = ((lead.stateMetadata as Record<string, unknown> | null) ?? {}) as Record<
        string,
        unknown
      >;
      await import('./prisma.ts').then(({ prisma }) =>
        prisma.lead.update({
          where: { id: lead.id },
          data: {
            stateMetadata: {
              ...prev,
              last_analyzed_hash: attachmentHash,
              last_analyzed_trigger: 'automation',
            },
          },
        }),
      );
    } catch (cacheErr) {
      console.warn('[AutoAnalysis] Failed to cache failed hash', {
        leadId: lead.id,
        hash: attachmentHash,
        err: cacheErr,
      });
    }
    return { triggered: false };
  }
}
