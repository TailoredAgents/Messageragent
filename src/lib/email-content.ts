import { format } from 'date-fns';
import { z } from 'zod';

import { getOpenAIClient } from './openai.js';

const DEFAULT_EMAIL_MODEL =
  process.env.EMAIL_MODEL ?? process.env.AGENT_MODEL ?? 'gpt-4.1-mini';

type MonetaryLine = {
  label: string;
  amount: number;
};

export type GeneratedEmail = {
  subject: string;
  text: string;
  html?: string;
};

type BookingEmailContext = {
  leadName?: string | null;
  companyName?: string | null;
  address?: string | null;
  windowStart: Date;
  windowEnd: Date;
  quoteTotal: number;
  subtotal: number;
  lineItems: MonetaryLine[];
  discounts: MonetaryLine[];
  notes: string[];
  disclaimer?: string | null;
  followUpPhone?: string | null;
  calendarUrl?: string | null;
};

type ReminderEmailContext = {
  leadName?: string | null;
  companyName?: string | null;
  address?: string | null;
  windowStart: Date;
  windowEnd: Date;
  reminderPhone?: string | null;
  additionalNotes?: string | null;
};

const EmailResponseSchema = z.object({
  subject: z.string().min(1, 'subject is required'),
  text: z.string().min(1, 'text is required'),
  html: z.string().optional(),
});

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

const buildLineItemSummary = (items: MonetaryLine[], prefix: string) => {
  if (items.length === 0) {
    return `${prefix}: none`;
  }
  const lines = items.map(
    (item) => `- ${item.label}: ${currencyFormatter.format(item.amount)}`,
  );
  return [prefix + ':', ...lines].join('\n');
};

const buildNotesSummary = (notes: string[]) => {
  if (notes.length === 0) {
    return 'Additional notes: none';
  }
  const lines = notes.map((note) => `- ${note}`);
  return ['Additional notes:', ...lines].join('\n');
};

const formatWindow = (windowStart: Date, windowEnd: Date) => {
  const dayLabel = format(windowStart, 'EEEE, MMMM d');
  const startLabel = format(windowStart, 'h:mm a');
  const endLabel = format(windowEnd, 'h:mm a');
  return `${dayLabel}, ${startLabel} - ${endLabel}`;
};

type PromptInput = {
  system: string;
  user: string;
};

async function generateEmail(prompt: PromptInput): Promise<GeneratedEmail> {
  const client = getOpenAIClient();
  const model = DEFAULT_EMAIL_MODEL;

  const response = await client.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: prompt.system,
      },
      {
        role: 'user',
        content: prompt.user,
      },
    ],
    response_format: { type: 'json_schema', json_schema: {
      name: 'email_payload',
      schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          text: { type: 'string' },
          html: { type: 'string' },
        },
        required: ['subject', 'text'],
        additionalProperties: false,
      },
    } },
  } as any);

  const raw = response.output_text;
  if (!raw) {
    throw new Error('Email generation returned an empty response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Email generation returned invalid JSON.');
  }

  return EmailResponseSchema.parse(parsed);
}

export async function generateBookingConfirmationEmail(
  context: BookingEmailContext,
): Promise<GeneratedEmail> {
  const lineItems = buildLineItemSummary(context.lineItems, 'Line items');
  const discounts = buildLineItemSummary(context.discounts, 'Discounts');
  const notes = buildNotesSummary(context.notes);
  const windowLabel = formatWindow(context.windowStart, context.windowEnd);
  const summary = [
    `Company name: ${context.companyName ?? 'Our team'}`,
    `Customer name: ${context.leadName ?? 'Unknown'}`,
    `Service address: ${context.address ?? 'N/A'}`,
    `Scheduled window: ${windowLabel}`,
    `Subtotal: ${currencyFormatter.format(context.subtotal)}`,
    `Total: ${currencyFormatter.format(context.quoteTotal)}`,
    lineItems,
    discounts,
    notes,
    `Disclaimer: ${context.disclaimer ?? 'N/A'}`,
    `Calendar link: ${context.calendarUrl ?? 'N/A'}`,
    context.followUpPhone
      ? `Contact phone for changes: ${context.followUpPhone}`
      : 'Contact phone for changes: N/A',
  ].join('\n');

  const prompt: PromptInput = {
    system: [
      'You are a concise, professional scheduling assistant for a junk removal company.',
      'Write engaging yet brief customer-facing emails.',
      'Honor the provided pricing disclaimer verbatim.',
      'Keep tone friendly, avoid jargon, and include clear next steps.',
      'Formats:',
      '- Subject line under 80 characters.',
      '- Body should open with a warm greeting using the customer name if known.',
      '- Provide a bulleted summary of the booking and estimate.',
      '- Close with gratitude and reminder how to reach out if plans change.',
      'Return JSON with subject, text, and optional html fields.',
    ].join('\n'),
    user: [
      'Compose a booking confirmation email and recap of the estimate.',
      `Context:\n${summary}`,
      'Ensure the disclaimer is present near the pricing details.',
    ].join('\n\n'),
  };

  return generateEmail(prompt);
}

export async function generateReminderEmail(
  context: ReminderEmailContext,
): Promise<GeneratedEmail> {
  const windowLabel = formatWindow(context.windowStart, context.windowEnd);
  const summaryLines = [
    `Company name: ${context.companyName ?? 'Our team'}`,
    `Customer name: ${context.leadName ?? 'Unknown'}`,
    `Service address: ${context.address ?? 'N/A'}`,
    `Scheduled window: ${windowLabel}`,
  ];

  if (context.reminderPhone) {
    summaryLines.push(`Reply/Contact number: ${context.reminderPhone}`);
  }

  if (context.additionalNotes) {
    summaryLines.push(`Additional notes: ${context.additionalNotes}`);
  }

  const prompt: PromptInput = {
    system: [
      'You are a helpful reminder assistant for a junk removal crew.',
      'Write friendly reminder emails that confirm logistics without adding new promises.',
      'Keep the body under 150 words and include a clear CTA if the customer needs to reschedule.',
      'Return JSON with subject, text, and optional html fields.',
    ].join('\n'),
    user: [
      'Compose a 24-hour reminder email for an upcoming junk removal job.',
      `Context:\n${summaryLines.join('\n')}`,
      'Mention the time window exactly as provided and prompt the customer to reply if anything has changed.',
    ].join('\n\n'),
  };

  return generateEmail(prompt);
}

