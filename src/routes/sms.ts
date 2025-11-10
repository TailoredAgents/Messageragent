import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';

import { getJunkQuoteAgent } from '../agent/index.ts';
import { buildAgentRunContext, getRunner } from '../lib/agent-runner.ts';
import { getTenantTimeZone } from '../lib/config.ts';
import { prisma } from '../lib/prisma.ts';
import { validateTwilioSignature } from '../adapters/twilio.ts';
import { recordLeadAttachments } from '../lib/attachments.ts';
import { maybeRunVisionAutomation } from '../lib/vision-automation.ts';

type LeadWithRelations = Prisma.LeadGetPayload<{
  include: { quotes: { orderBy: { createdAt: 'desc' } } };
}>;

type TwilioWebhookBody = {
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  [key: `MediaUrl${number}`]: string | undefined;
  [key: string]: unknown;
};

const CURBSIDE_KEYWORDS = ['curbside', 'driveway', 'garage', 'staged'];

async function ensureSmsLead(
  phone: string,
): Promise<{ lead: LeadWithRelations; isNew: boolean }> {
  const existing = await prisma.lead.findFirst({
    where: { phone },
    include: { quotes: { orderBy: { createdAt: 'desc' } } },
  });

  if (existing) {
    return { lead: existing, isNew: false };
  }

  const created = await prisma.lead.create({
    data: {
      channel: 'sms',
      phone,
      stage: 'awaiting_photos',
    },
    include: { quotes: { orderBy: { createdAt: 'desc' } } },
  });

  return { lead: created, isNew: true };
}

async function ensureConversation({
  channel,
  externalId,
  leadId,
  customerId,
}: {
  channel: 'messenger' | 'sms';
  externalId: string;
  leadId: string;
  customerId?: string | null;
}) {
  return prisma.conversation.upsert({
    where: { channel_externalId: { channel, externalId } },
    update: {
      leadId,
      customerId: customerId ?? undefined,
      lastMessageAt: new Date(),
    },
    create: {
      channel,
      externalId,
      leadId,
      customerId: customerId ?? undefined,
      lastMessageAt: new Date(),
    },
  });
}

function gatherMedia(body: TwilioWebhookBody): string[] {
  const numMedia = Number.parseInt((body.NumMedia ?? '0') as string, 10);
  if (Number.isNaN(numMedia) || numMedia <= 0) {
    return [];
  }

  const media: string[] = [];
  for (let index = 0; index < numMedia; index += 1) {
    const url = body[`MediaUrl${index}`];
    if (typeof url === 'string' && url.length > 0) {
      media.push(url);
    }
  }
  return media;
}

function buildAgentInput({
  lead,
  text,
  attachments,
}: {
  lead: LeadWithRelations;
  text: string;
  attachments: string[];
}): string {
  const contextLines = [
    `Lead ID: ${lead.id}`,
    `Stage: ${lead.stage}`,
    `Known address: ${lead.address ?? 'unknown'}`,
    `Curbside flag: ${lead.curbside ? 'true' : 'false'}`,
    `Latest quote: ${lead.quotes[0]?.id ?? 'none'}`,
    `Channel: sms`,
  ];

  const attachmentSummary =
    attachments.length > 0
      ? `Photos provided:\n${attachments.join('\n')}`
      : 'No photos attached yet.';

  return [
    'Context:',
    contextLines.join('\n'),
    '\nCustomer message:',
    text,
    '\n',
    attachmentSummary,
  ].join('\n');
}

async function processSmsEvent(
  body: TwilioWebhookBody,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const from = body.From;
  const rawBody = (body.Body ?? '').toString();
  const messageText = rawBody.trim();
  const attachments = gatherMedia(body);
  const textPayload =
    messageText.length > 0
      ? messageText
      : attachments.length > 0
        ? '[photos uploaded]'
        : null;

  if (!from || !textPayload) {
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

  const { lead, isNew } = await ensureSmsLead(from);
  const conversation = await ensureConversation({
    channel: 'sms',
    externalId: from,
    leadId: lead.id,
    customerId: lead.customerId,
  });

  const attachmentHistory = await recordLeadAttachments(
    lead.id,
    attachments,
    'sms',
  );
  const attachmentsForContext =
    attachmentHistory.length > 0 ? attachmentHistory : attachments;

  const lowerText = textPayload.toLowerCase();
  const curbsideDetected = CURBSIDE_KEYWORDS.some((keyword) =>
    lowerText.includes(keyword),
  );

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      curbside: curbsideDetected ? true : lead.curbside,
      lastCustomerMessageAt: new Date(),
      phone: from,
    },
  });

  if (curbsideDetected) {
    lead.curbside = true;
  }

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'customer',
      action: 'customer_sms',
      payload: {
        text: textPayload,
        attachments,
        attachment_history: attachmentHistory,
        is_new_lead: isNew,
      } as Prisma.JsonObject,
    },
  });

  const runner = getRunner();
  const agent = getJunkQuoteAgent();

  const inputText = buildAgentInput({
    lead,
    text: textPayload,
    attachments: attachmentsForContext,
  });

  void maybeRunVisionAutomation({
    lead,
    attachments: attachmentsForContext,
    channel: 'sms',
  }).catch((error) => {
    request.log.error({ err: error, leadId: lead.id }, 'Auto vision analysis failed');
  });

  const timeZone = getTenantTimeZone();
  await runner.run(agent, inputText, {
    context: buildAgentRunContext({
      leadId: lead.id,
      conversationId: conversation.id,
      customerId: lead.customerId,
      channel: 'sms',
      timeZone,
      smsFrom: from,
      attachments: attachmentsForContext,
    }),
  });

  reply.type('text/xml').send('<Response></Response>');
}

export async function smsRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/api/twilio/sms',
    async (
      request: FastifyRequest<{ Body: TwilioWebhookBody }>,
      reply: FastifyReply,
    ) => {
      const signature = request.headers['x-twilio-signature'] as
        | string
        | undefined;

      const rawUrl =
        process.env.TWILIO_WEBHOOK_URL ??
        `${request.protocol}://${request.headers.host}${request.url}`;

      const isValidSignature = validateTwilioSignature({
        url: rawUrl,
        params: request.body as Record<string, unknown>,
        signature,
      });

      if (!isValidSignature) {
        reply.code(403).send('Invalid Twilio signature');
        return;
      }

      try {
        await processSmsEvent(request.body ?? {}, request, reply);
      } catch (error) {
        fastify.log.error({ err: error }, 'Error processing SMS webhook');
        reply.code(500).send('Error');
      }
    },
  );
}
