import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { sendMessengerMessage } from '../adapters/messenger.ts';
import { sendSmsMessage } from '../adapters/twilio.ts';
import { prisma } from '../lib/prisma.ts';

const sendMessageParameters = z
  .object({
    lead_id: z.string().uuid('lead_id must be a valid UUID'),
    text: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, 'text must be a non-empty string')
          .max(1500, 'text cannot exceed 1500 characters'),
      ),
    channel: z.enum(['messenger', 'sms']).optional(),
    to: z
      .string()
      .trim()
      .min(1, 'to must be a non-empty string')
      .optional(),
    quick_replies: z
      .array(
        z.object({
          title: z.string().max(20),
          payload: z.string().max(256),
        }),
      )
      .max(11)
      .optional(),
    attachments: z
      .array(
        z.object({
          type: z.enum(['image', 'file']),
          url: z.string().url(),
        }),
      )
      .max(1)
      .optional(),
  })
  .transform((input) => ({
    ...input,
    channel: input.channel ?? undefined,
    to: input.to ?? undefined,
    quick_replies: input.quick_replies ?? undefined,
    attachments: input.attachments ?? undefined,
  }));

type RunnerToolContext = {
  leadId?: string;
  messengerPsid?: string;
  smsFrom?: string;
  attachments?: string[];
};

type SendMessageInput = z.infer<typeof sendMessageParameters>;

type SendMessageResult = {
  status: 'queued' | 'sent';
};

async function sendMessage(
  input: SendMessageInput,
  runContext?: RunnerToolContext,
): Promise<SendMessageResult> {
  const lead = await prisma.lead.findUnique({ where: { id: input.lead_id } });
  if (!lead) {
    throw new Error('Lead not found for messaging.');
  }

  const channel = resolveChannel(input.channel, lead.channel, runContext);
  const recipient = resolveRecipient({
    channel,
    explicitRecipient: input.to,
    lead,
    context: runContext,
  });

  if (!recipient) {
    throw new Error(
      channel === 'messenger'
        ? 'Messenger recipient missing and no stored PSID found.'
        : 'SMS recipient missing.',
    );
  }

  if (channel === 'sms' && input.quick_replies?.length) {
    throw new Error('Quick replies are not supported over SMS.');
  }

  if (channel === 'sms' && input.attachments?.length) {
    throw new Error('Attachments are not supported over SMS.');
  }

  if (channel === 'messenger') {
    await sendMessengerMessage({
      to: recipient,
      text: input.text,
      quickReplies: input.quick_replies,
      attachments: input.attachments,
      jitter: isMessengerJitterEnabled(),
    });
  } else {
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
        channel,
        to: recipient,
        has_quick_replies: Boolean(input.quick_replies?.length),
        recipient_inferred: !input.to,
      } as Prisma.JsonObject,
    },
  });

  return { status: 'sent' };
}

function resolveChannel(
  explicitChannel: SendMessageInput['channel'],
  leadChannel: Prisma.Channel,
  context?: RunnerToolContext,
): 'messenger' | 'sms' {
  if (explicitChannel) {
    return explicitChannel;
  }
  if (context?.smsFrom) {
    return 'sms';
  }
  if (context?.messengerPsid) {
    return 'messenger';
  }
  return leadChannel ?? 'messenger';
}

function resolveRecipient({
  channel,
  explicitRecipient,
  lead,
  context,
}: {
  channel: 'messenger' | 'sms';
  explicitRecipient?: string;
  lead: { messengerPsid: string | null; phone: string | null };
  context?: RunnerToolContext;
}): string | undefined {
  if (explicitRecipient) {
    return explicitRecipient;
  }
  if (channel === 'messenger') {
    return context?.messengerPsid ?? lead.messengerPsid ?? undefined;
  }
  return context?.smsFrom ?? lead.phone ?? undefined;
}

function isMessengerJitterEnabled(): boolean {
  const jitterPref = String(process.env.MESSENGER_JITTER_ENABLED ?? 'true')
    .toLowerCase()
    .trim();
  return !['0', 'false', 'no', 'off'].includes(jitterPref);
}

function buildSendMessageJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      lead_id: {
        type: 'string',
        description: 'Lead identifier associated with the outbound message.',
      },
      text: {
        type: 'string',
        maxLength: 1500,
        description:
          'Customer-facing response. Keep tone human and conversational.',
      },
    },
    required: ['lead_id', 'text'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  } as const;
}

export function buildSendMessageTool() {
  const sendMessageJsonSchema = buildSendMessageJsonSchema();

  return tool({
    name: 'send_message',
    description:
      'Send a reply to the customer via Messenger or SMS. Always call this to deliver final responses.',
    parameters: sendMessageJsonSchema,
    execute: async (args, runContext) =>
      sendMessage(
        sendMessageParameters.parse(args),
        (runContext?.context as RunnerToolContext | undefined) ?? undefined,
      ),
  });
}
