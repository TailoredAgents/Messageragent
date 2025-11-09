import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { addDays, addMinutes } from 'date-fns';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';
import { ProposedSlot } from '../lib/types.ts';
import { formatLocalRange, getLocalYMD, makeZonedDate } from '../lib/time.ts';
import { calendarFeatureEnabled, getCalendarConfig, isWindowFree } from '../lib/google-calendar.ts';
import { resolvePreferredDateTime } from '../lib/date-parser.ts';

const proposeSlotsParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    preferred_day: z.string().nullish(),
    preferred_time_text: z.string().nullish(),
  })
  .transform((data) => ({
    ...data,
    preferred_day: data.preferred_day ?? undefined,
    preferred_time_text: data.preferred_time_text ?? undefined,
  }));

type ProposeSlotsInput = z.infer<typeof proposeSlotsParameters>;

type ProposeSlotsResult = {
  slots: ProposedSlot[];
};

const BUSINESS_START_HOUR = 8; // 8 AM local
const BUSINESS_END_HOUR = 18; // 6 PM local
const SLOT_STEP_MIN = 15;
const MIN_GAP_MIN = 30;
const MAX_SUGGESTIONS = 4;

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

  const calendarEnabled = calendarFeatureEnabled();
  const cfg = getCalendarConfig();
  const tz = cfg?.timeZone ?? 'America/New_York';
  let preferredMoment = (input.preferred_day && new Date(input.preferred_day)) || new Date();
  if (input.preferred_time_text) {
    const resolved = await resolvePreferredDateTime(
      input.preferred_time_text,
      tz,
      new Date(),
    );
    if (resolved) {
      preferredMoment = resolved;
    }
  }

  const now = new Date();
  if (preferredMoment.getTime() < now.getTime()) {
    const diffMs = now.getTime() - preferredMoment.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (diffMs < oneDayMs) {
      preferredMoment = now;
    } else {
      const weeksBehind = Math.floor(diffMs / (7 * oneDayMs)) + 1;
      preferredMoment = addDays(preferredMoment, weeksBehind * 7);
    }
  }

  const { y, m, d } = getLocalYMD(preferredMoment, tz);
  const durationMin = estimateDurationMinutesFromLead(lead);

  const suggestions: ProposedSlot[] = [];
  const preferredMinutes = preferredMoment.getHours() * 60 + preferredMoment.getMinutes();
  let lastAcceptedEnd: Date | null = null;

  for (let dayOffset = 0; dayOffset < 7 && suggestions.length < MAX_SUGGESTIONS; dayOffset++) {
    const base = addDays(new Date(Date.UTC(y, m - 1, d, 0, 0, 0)), dayOffset);
    const { y: yy, m: mm, d: dd } = getLocalYMD(base, tz);

    const candidates: ProposedSlot[] = [];

    for (
      let totalMinutes = BUSINESS_START_HOUR * 60;
      totalMinutes <= BUSINESS_END_HOUR * 60;
      totalMinutes += SLOT_STEP_MIN
    ) {
      const hour = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;
      const start = makeZonedDate(tz, yy, mm, dd, hour, minute);
      if (start.getTime() < Date.now()) continue;
      const end = addMinutes(start, durationMin);
      const endMinutesLocal = Number(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(end),
      ) * 60;
      if (endMinutesLocal > BUSINESS_END_HOUR * 60) continue;

      if (calendarEnabled && cfg) {
        try {
          const free = await isWindowFree(start.toISOString(), end.toISOString(), cfg.id, tz);
          if (!free) continue;
        } catch (e) {
          console.warn('[Calendar] freebusy failed; proceeding with candidate', e);
        }
      }

      candidates.push({
        id: `${lead.id}-${start.toISOString()}`,
        label: formatLocalRange(tz, start, end),
        window_start: start.toISOString(),
        window_end: end.toISOString(),
      });
    }

    // Prioritize slots closest to preferred time, but also spread morning/midday/afternoon
    const segments = [
      candidates.filter((slot) => new Date(slot.window_start).getHours() < 11),
      candidates.filter((slot) => {
        const h = new Date(slot.window_start).getHours();
        return h >= 11 && h < 15;
      }),
      candidates.filter((slot) => new Date(slot.window_start).getHours() >= 15),
    ];

    for (const segment of segments) {
      segment.sort((a, b) =>
        Math.abs(new Date(a.window_start).getHours() * 60 + new Date(a.window_start).getMinutes() - preferredMinutes) -
        Math.abs(new Date(b.window_start).getHours() * 60 + new Date(b.window_start).getMinutes() - preferredMinutes),
      );
    }

    const balanced: ProposedSlot[] = [];
    while (balanced.length < MAX_SUGGESTIONS && segments.some((seg) => seg.length > 0)) {
      for (const segment of segments) {
        if (segment.length === 0) continue;
        const slot = segment.shift();
        if (!slot) continue;

        if (calendarEnabled && cfg) {
          const start = new Date(slot.window_start);
          if (lastAcceptedEnd && start.getTime() - lastAcceptedEnd.getTime() < MIN_GAP_MIN * 60 * 1000) {
            continue;
          }
          lastAcceptedEnd = new Date(slot.window_end);
        }

        balanced.push(slot);
        if (balanced.length >= MAX_SUGGESTIONS) break;
      }
    }

    for (const slot of balanced) {
      suggestions.push(slot);
      if (suggestions.length >= MAX_SUGGESTIONS) break;
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
    preferred_time_text: {
      description:
        'Optional raw phrase the customer used for their preferred day/time (e.g., "this Friday at 3 pm").',
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
    },
  },
  required: ['lead_id', 'preferred_day', 'preferred_time_text'],
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
          preferred_time_text: null,
          ...args,
        }),
      ),
  });
}
