import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { addDays, setHours, setMinutes, startOfDay } from 'date-fns';
import { z } from 'zod';

import { prisma } from '../lib/prisma.ts';
import { ProposedSlot } from '../lib/types.ts';

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

const SLOT_WINDOWS = [
  { startHour: 12, endHour: 15 },
  { startHour: 15, endHour: 18 },
];

const buildSlotLabel = (
  baseDate: Date,
  startHour: number,
  endHour: number,
) => {
  const tomorrow = addDays(new Date(), 1);
  const isTomorrow =
    baseDate.getDate() === tomorrow.getDate() &&
    baseDate.getMonth() === tomorrow.getMonth();
  const dayLabel = isTomorrow
    ? 'Tomorrow'
    : baseDate.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });
  return `${dayLabel} ${startHour}-${endHour}`;
};

async function proposeSlots(input: ProposeSlotsInput): Promise<ProposeSlotsResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
  });

  if (!lead) {
    throw new Error('Lead not found for proposing slots.');
  }

  const preferredDate =
    (input.preferred_day && new Date(input.preferred_day)) || addDays(new Date(), 1);
  const baseDate = Number.isNaN(preferredDate.valueOf())
    ? addDays(new Date(), 1)
    : preferredDate;

  const start = startOfDay(baseDate);

  const slots: ProposedSlot[] = SLOT_WINDOWS.map(({ startHour, endHour }) => {
    const windowStart = setMinutes(setHours(start, startHour), 0);
    const windowEnd = setMinutes(setHours(start, endHour), 0);
    return {
      id: `${lead.id}-${startHour}-${endHour}`,
      label: buildSlotLabel(baseDate, startHour, endHour),
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
    };
  });

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
