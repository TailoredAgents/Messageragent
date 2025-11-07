import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { sendMessengerMessage } from '../adapters/messenger.ts';
import { sendSmsMessage } from '../adapters/twilio.ts';
import { prisma } from '../lib/prisma.ts';

const sendMessageParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    channel: z.union([z.literal('messenger'), z.literal('sms')]),
    to: z
      .string()
      .trim()
      .min(1, 'to must be a non-empty string')
      .nullish(),
    text: z.string().max(1500).nullish(),
    quick_replies: z
      .array(
        z.object({
          title: z.string().max(20),
          payload: z.string().max(256),
        }),
      )
      .max(11)
      .nullish(),
    attachments: z
      .array(
        z.object({
          type: z.enum(['image', 'file']),
          url: z.string().url(),
        }),
      )
      .max(1)
      .nullish(),
  })
  .superRefine((input, ctx) => {
    if (input.channel === 'sms' && !input.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SMS messages must include a recipient phone number.',
        path: ['to'],
      });
    }
  })
  .transform((input) => ({
    ...input,
    to: input.to ?? undefined,
    text: input.text ?? undefined,
    quick_replies: input.quick_replies ?? undefined,
    attachments: input.attachments ?? undefined,
  }));

type SendMessageInput = z.infer<typeof sendMessageParameters>;

type SendMessageResult = {
  status: 'queued' | 'sent';
};

async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const lead = await prisma.lead.findUnique({ where: { id: input.lead_id } });
  if (!lead) {
    throw new Error('Lead not found for messaging.');
  }

  const recipient =
    input.channel === 'messenger'
      ? input.to ?? lead.messengerPsid ?? undefined
      : input.to;

  if (!recipient) {
    throw new Error(
      input.channel === 'messenger'
        ? 'Messenger recipient missing and no stored PSID found.'
        : 'SMS recipient missing.',
    );
  }

  if (input.channel === 'messenger') {
    const jitterPref = String(process.env.MESSENGER_JITTER_ENABLED ?? 'false')
      .toLowerCase()
      .trim();
    const jitterEnabled = !['0', 'false', 'no', 'off'].includes(jitterPref);

    await sendMessengerMessage({
      to: recipient,
      text: input.text,
      quickReplies: input.quick_replies,
      attachments: input.attachments,
      jitter: jitterEnabled,
    });
  } else {
    if (!input.text) {
      throw new Error('SMS messages must include text content.');
    }
    await sendSmsMessage(recipient, input.text);
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastAgentMessageAt: new Date(),
    },
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'agent',
      action: 'send_message',
      payload: {
        channel: input.channel,
        to: recipient,
        has_quick_replies: Boolean(input.quick_replies?.length),
        recipient_inferred: input.to !== recipient,
      } as Prisma.JsonObject,
    },
  });

  return { status: 'sent' };
}

export function buildSendMessageTool() {
  const sendMessageJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      lead_id: {
        type: 'string',
        description: 'Lead identifier associated with the outbound message.',
      },
      channel: {
        type: 'string',
        enum: ['messenger', 'sms'],
        description: 'Delivery channel for the message.',
      },
      to: {
        description:
          'Destination user identifier or phone number. For Messenger, leave null to fall back to the stored PSID.',
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'null' },
        ],
        default: null,
      },
      text: {
        description: 'Optional message body.',
        anyOf: [
          { type: 'string', maxLength: 1500 },
          { type: 'null' },
        ],
        default: null,
      },
      quick_replies: {
        description: 'Optional Messenger quick reply buttons.',
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: {
                  type: 'string',
                  maxLength: 20,
                  description: 'Label presented to the customer.',
                },
                payload: {
                  type: 'string',
                  maxLength: 256,
                  description: 'Payload returned when the button is tapped.',
                },
              },
              required: ['title', 'payload'],
            },
            maxItems: 11,
          },
          { type: 'null' },
        ],
        default: null,
      },
      attachments: {
        description: 'Optional image or file attachment (Messenger only).',
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: {
                  type: 'string',
                  enum: ['image', 'file'],
                  description: 'Attachment type supported by Messenger.',
                },
                url: {
                  type: 'string',
                  description: 'Public HTTPS URL for the attachment.',
                  pattern: '^https://.+',
                },
              },
              required: ['type', 'url'],
            },
            maxItems: 1,
          },
          { type: 'null' },
        ],
        default: null,
      },
    },
    required: ['lead_id', 'channel', 'to', 'text', 'quick_replies', 'attachments'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  } as const;

  return tool({
    name: 'send_message',
    description:
      'Send a reply to the customer via Messenger. Always call this to deliver final responses.',
    parameters: sendMessageJsonSchema,
    execute: async (args) =>
      sendMessage(
        sendMessageParameters.parse({
          to: null,
          text: null,
          quick_replies: null,
          attachments: null,
          ...args,
        }),
      ),
  });
}
