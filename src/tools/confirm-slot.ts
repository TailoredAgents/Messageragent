import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { subHours } from 'date-fns';
import { z } from 'zod';

import { createCalendarHold } from '../lib/calendar.ts';
import {
  calendarFeatureEnabled,
  getCalendarConfig,
  isWindowFree,
} from '../lib/google-calendar.ts';
import { generateBookingConfirmationEmail } from '../lib/email-content.ts';
import { sendTransactionalEmail } from '../lib/email.ts';
import { prisma } from '../lib/prisma.ts';

const slotSchema = z
  .object({
    id: z.string(),
    window_start: z.string(),
    window_end: z.string(),
    label: z.string().nullish(),
  })
  .transform((slot) => ({
    ...slot,
    label: slot.label ?? undefined,
  }));

const confirmSlotParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    slot: slotSchema,
    quote_id: z.string().uuid().nullish(),
    notes: z.string().nullish(),
  })
  .transform((data) => ({
    ...data,
    quote_id: data.quote_id ?? undefined,
    notes: data.notes ?? undefined,
  }));

type ConfirmSlotInput = z.infer<typeof confirmSlotParameters>;

type ConfirmSlotResult = {
  job_id: string;
  quote_id: string;
  window_start: string;
  window_end: string;
  reminder_scheduled_at?: string;
  calendar_url?: string;
};

const monetaryArraySchema = z
  .array(z.object({ label: z.string(), amount: z.number() }))
  .default([]);
const notesArraySchema = z.array(z.string()).default([]);

async function confirmSlot(input: ConfirmSlotInput): Promise<ConfirmSlotResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.lead_id },
  });

  if (!lead) {
    throw new Error('Lead not found for booking.');
  }

  const windowStart = new Date(input.slot.window_start);
  const windowEnd = new Date(input.slot.window_end);

  if (Number.isNaN(windowStart.valueOf()) || Number.isNaN(windowEnd.valueOf())) {
    throw new Error('Slot window is invalid.');
  }

  const quote =
    (input.quote_id &&
      (await prisma.quote.findUnique({ where: { id: input.quote_id } }))) ||
    (await prisma.quote.findFirst({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
    }));

  if (!quote) {
    throw new Error('No quote found to attach to job.');
  }

  const reminderAt = subHours(windowStart, 24);

  const job = await prisma.job.upsert({
    where: { quoteId: quote.id },
    create: {
      leadId: lead.id,
      quoteId: quote.id,
      windowStart,
      windowEnd,
      status: 'booked',
      reminderScheduledAt: reminderAt,
    },
    update: {
      windowStart,
      windowEnd,
      status: 'booked',
      reminderScheduledAt: reminderAt,
    },
  });

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: 'booked',
      stateMetadata: {
        ...((lead.stateMetadata as Prisma.JsonObject) ?? {}),
        booked_job_id: job.id,
        reminder_at: reminderAt.toISOString(),
      },
    },
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'agent',
      action: 'confirm_slot',
      payload: {
        job_id: job.id,
        slot_id: input.slot.id,
      } as Prisma.JsonObject,
    },
  });

  const calendar = await createCalendarHold({
    jobId: job.id,
    leadName: lead.name,
    address: lead.address,
    windowStart,
    windowEnd,
    baseUrl: process.env.BASE_URL,
  });

  if (lead.email) {
    const lineItems = monetaryArraySchema.parse(
      quote.lineItemsJson ?? undefined,
    );
    const discounts = monetaryArraySchema.parse(
      quote.discountsJson ?? undefined,
    );
    const notes = notesArraySchema.parse(quote.notesJson ?? undefined);

    try {
      const companyName = process.env.COMPANY_NAME ?? 'Junk Wizards';
      const email = await generateBookingConfirmationEmail({
        leadName: lead.name,
        companyName,
        address: lead.address,
        windowStart,
        windowEnd,
        quoteTotal: quote.total.toNumber(),
        subtotal: quote.subtotal.toNumber(),
        lineItems,
        discounts,
        notes,
        disclaimer: quote.disclaimer,
        followUpPhone: process.env.SUPPORT_PHONE ?? lead.phone,
        calendarUrl: calendar.url,
      });

      await sendTransactionalEmail({
        to: lead.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      await prisma.audit.create({
        data: {
          leadId: lead.id,
          actor: 'system',
          action: 'booking_email_sent',
          payload: {
            job_id: job.id,
            quote_id: quote.id,
          } as Prisma.JsonObject,
        },
      });
    } catch (error) {
      console.error('Failed to send booking confirmation email', error);
      await prisma.audit.create({
        data: {
          leadId: lead.id,
          actor: 'system',
          action: 'booking_email_failed',
          payload: {
            job_id: job.id,
            quote_id: quote.id,
            error: error instanceof Error ? error.message : 'unknown error',
          } as Prisma.JsonObject,
        },
      });
    }
  }

  return {
    job_id: job.id,
    quote_id: quote.id,
    window_start: job.windowStart.toISOString(),
    window_end: job.windowEnd.toISOString(),
    reminder_scheduled_at: job.reminderScheduledAt?.toISOString(),
    calendar_url: calendar.url,
  };
}

const confirmSlotJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lead_id: {
      type: 'string',
      description: 'Lead identifier for the booking being confirmed.',
    },
    slot: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'Identifier for the proposed slot that was accepted.',
        },
        window_start: {
          type: 'string',
          description: 'ISO timestamp when the pickup window opens.',
          format: 'date-time',
        },
        window_end: {
          type: 'string',
          description: 'ISO timestamp when the pickup window closes.',
          format: 'date-time',
        },
        label: {
          description: 'Optional label shown to the customer.',
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
        },
      },
      required: ['id', 'window_start', 'window_end', 'label'],
    },
    quote_id: {
      description: 'Quote identifier to associate with the job.',
      anyOf: [
        {
          type: 'string',
          format: 'uuid',
        },
        { type: 'null' },
      ],
      default: null,
    },
    notes: {
      description: 'Optional notes to record with the booking.',
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
    },
  },
  required: ['lead_id', 'slot', 'quote_id', 'notes'],
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

export function buildConfirmSlotTool() {
  return tool({
    name: 'confirm_slot',
    description:
      'Books the customer into a pickup window, creates a job, and schedules an automatic reminder.',
    parameters: confirmSlotJsonSchema,
    execute: async (args) => {
      const raw = args as Record<string, unknown>;
      const normalized = {
        quote_id: null,
        notes: null,
        ...raw,
        slot: {
          label: null,
          ...((raw.slot as Record<string, unknown> | undefined) ?? {}),
        },
      };
      return confirmSlot(confirmSlotParameters.parse(normalized));
    },
  });
}
  // Safety recheck against Google Calendar to avoid double-booking.
  if (calendarFeatureEnabled()) {
    const cfg = getCalendarConfig();
    if (cfg) {
      const free = await isWindowFree(
        windowStart.toISOString(),
        windowEnd.toISOString(),
        cfg.id,
        cfg.timeZone,
      );
      if (!free) {
        throw new Error(
          'That window was just booked. Please pick the other window or another day.',
        );
      }
    }
  }
