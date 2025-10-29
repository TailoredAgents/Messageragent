import { tool } from '@openai/agents';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { sendMessengerMessage } from '../adapters/messenger.js';
import { sendSmsMessage } from '../adapters/twilio.js';
import { prisma } from '../lib/prisma.js';

const sendMessageParameters = z.object({
  lead_id: z.string().uuid('lead_id must be a valid UUID'),
  channel: z.union([z.literal('messenger'), z.literal('sms')]),
  to: z.string(),
  text: z.string().max(1500).optional(),
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
});

type SendMessageInput = z.infer<typeof sendMessageParameters>;

type SendMessageResult = {
  status: 'queued' | 'sent';
};

async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const lead = await prisma.lead.findUnique({ where: { id: input.lead_id } });
  if (!lead) {
    throw new Error('Lead not found for messaging.');
  }

  if (input.channel === 'messenger') {
    await sendMessengerMessage({
      to: input.to,
      text: input.text,
      quickReplies: input.quick_replies,
      attachments: input.attachments,
    });
  } else {
    if (!input.text) {
      throw new Error('SMS messages must include text content.');
    }
    await sendSmsMessage(input.to, input.text);
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
        to: input.to,
        has_quick_replies: Boolean(input.quick_replies?.length),
      } as Prisma.JsonObject,
    },
  });

  return { status: 'sent' };
}

export function buildSendMessageTool() {
  return tool({
    name: 'send_message',
    description:
      'Send a reply to the customer via Messenger. Always call this to deliver final responses.',
    parameters: sendMessageParameters,
    execute: sendMessage,
  });
}
