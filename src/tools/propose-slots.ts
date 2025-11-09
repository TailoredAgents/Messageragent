import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { addDays, addMinutes } from 'date-fns';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';
import { ProposedSlot } from '../lib/types.ts';
import { formatLocalRange, getLocalYMD, makeZonedDate } from '../lib/time.ts';
import { calendarFeatureEnabled, getCalendarConfig, isWindowFree } from '../lib/google-calendar.ts';

const proposeSlotsParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    preferred_day: z.string().nullish(),
  })
  .transform((data) => ({
    ...data,
    preferred_day: data.preferred_day ?? undefined,
  }));

type ProposeSlotsInput = z.infer<typeof proposeSlotsParameters>;

type ProposeSlotsResult = {
  slots: ProposedSlot[];
};

const BUSINESS_START_HOUR = 8; // 8 AM local
const BUSINESS_END_HOUR = 18; // 6 PM local

function estimateDurationMinutesFromLead(lead: { stateMetadata: unknown }): number {
  try {
    const meta = (lead.stateMetadata as Record<string, unknown>) ?? {};
    const last = meta['last_features'] as Record<string, unknown> | undefined;
    const yards = Number((last?.['cubic_yards_est'] as number | undefined) ?? 0);
    const quarters = Math.max(1, Math.ceil(yards / 4));
    let minutes = quarters * 90; // ~1.5h per quarter load
    const heavy = Array.isArray(last?.['heavy_items']) && (last!['heavy_items'] as unknown[]).length > 0;
    const stairs = Number((last?.['stairs_flights'] as number | undefined) ?? 0) > 0;
    const longCarry = Number((last?.['carry_distance_ft'] as number | undefined) ?? 0) > 50;
    if (heavy || stairs || longCarry) minutes += 30;
    return minutes;
  } catch {
    return 90;
  }
}

async function proposeSlots(input: ProposeSlotsInput): Promise<ProposeSlotsResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
  });

  if (!lead) {
    throw new Error('Lead not found for proposing slots.');
  }

  const preferredDate = (input.preferred_day && new Date(input.preferred_day)) || new Date();
  const cfg = getCalendarConfig();
  const tz = cfg?.timeZone ?? 'America/New_York';
  const { y, m, d } = getLocalYMD(preferredDate, tz);
  const durationMin = estimateDurationMinutesFromLead(lead);

  const suggestions: ProposedSlot[] = [];
  const maxSuggestions = 4;

  for (let dayOffset = 0; dayOffset < 7 && suggestions.length < maxSuggestions; dayOffset++) {
    const base = addDays(new Date(Date.UTC(y, m - 1, d, 0, 0, 0)), dayOffset);
    const { y: yy, m: mm, d: dd } = getLocalYMD(base, tz);
    for (let hour = BUSINESS_START_HOUR; hour <= BUSINESS_END_HOUR; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const start = makeZonedDate(tz, yy, mm, dd, hour, minute);
        const end = addMinutes(start, durationMin);
        // Skip past
        if (start.getTime() < Date.now()) continue;
        // Ensure end still within business day in local TZ
        const endLocalHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(end));
        if (endLocalHour > BUSINESS_END_HOUR) continue;

        if (calendarFeatureEnabled() && cfg) {
          try {
            const free = await isWindowFree(start.toISOString(), end.toISOString(), cfg.id, tz);
            if (!free) continue;
          } catch (e) {
            console.warn('[Calendar] freebusy failed; proceeding with candidate', e);
          }
        }

        suggestions.push({
          id: `${lead.id}-${start.toISOString()}`,
          label: formatLocalRange(tz, start, end),
          window_start: start.toISOString(),
          window_end: end.toISOString(),
        });
        if (suggestions.length >= maxSuggestions) break;
      }
      if (suggestions.length >= maxSuggestions) break;
    }
  }

  const slots: ProposedSlot[] = suggestions;

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: 'scheduling',
      stateMetadata: {
        ...((lead.stateMetadata as Prisma.JsonObject) ?? {}),
        proposed_slots: slots,
        proposed_at: new Date().toISOString(),
      },
    },
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'agent',
      action: 'propose_slots',
      payload: { slot_ids: slots.map((slot) => slot.id) } as Prisma.JsonObject,
    },
  });

  return { slots };
}

const proposeSlotsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier to propose scheduling options for.',
    },
    preferred_day: {
      description:
        'Optional ISO date string pushing proposed windows toward a day.',
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
    },
  },
  required: ['lead_id', 'preferred_day'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildProposeSlotsTool() {
  return tool({
    name: 'propose_slots',
    description:
      'Suggests two junk pickup windows for the customer to choose from. Use before booking.',
    parameters: proposeSlotsJsonSchema,
    execute: async (args) =>
      proposeSlots(
        proposeSlotsParameters.parse({
          preferred_day: null,
          ...args,
        }),
      ),
  });
}
