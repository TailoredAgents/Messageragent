import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';

import { getJunkQuoteAgent } from '../agent/index.ts';
import { getRunner } from '../lib/agent-runner.ts';
import { prisma } from '../lib/prisma.ts';
import { validateTwilioSignature } from '../adapters/twilio.ts';

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
  const messageText = (body.Body ?? '').toString().trim();

  if (!from || !messageText) {
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

  const attachments = gatherMedia(body);
  const { lead, isNew } = await ensureSmsLead(from);

  const lowerText = messageText.toLowerCase();
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
        text: messageText,
        attachments,
        is_new_lead: isNew,
      } as Prisma.JsonObject,
    },
  });

  const runner = getRunner();
  const agent = getJunkQuoteAgent();

  const inputText = buildAgentInput({
    lead,
    text: messageText,
    attachments,
  });

  await runner.run(agent, inputText, {
    context: {
      leadId: lead.id,
      smsFrom: from,
      attachments,
    },
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
