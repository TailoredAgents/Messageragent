import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';

import { getJunkQuoteAgent } from '../agent/index.ts';
import { getRunner } from '../lib/agent-runner.ts';
import { prisma } from '../lib/prisma.ts';
import { recordLeadAttachments } from '../lib/attachments.ts';
import { maybeRunVisionAutomation } from '../lib/vision-automation.ts';

type LeadWithRelations = Prisma.LeadGetPayload<{
  include: { quotes: { orderBy: { createdAt: 'desc' } } };
}>;

type MessengerAttachment = {
  type: string;
  payload: { url?: string };
};

type MessengerMessage = {
  mid: string;
  text?: string;
  attachments?: MessengerAttachment[];
  quick_reply?: { payload: string };
};

type MessengerEvent = {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MessengerMessage;
  postback?: { title?: string; payload?: string };
};

type MessengerWebhookPayload = {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    messaging: MessengerEvent[];
  }>;
};

const CURBSIDE_KEYWORDS = ['curbside', 'driveway', 'garage', 'staged'];
const PHOTO_REFERENCE_REGEX = /\b(photo|photos|pic|pics|picture|pictures|image|images)\b/i;

type Logger = Pick<FastifyRequest['log'], 'info' | 'warn' | 'error' | 'child'>;

const sanitizeText = (text: string | undefined): string | null => {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

async function ensureLead(
  psid: string,
): Promise<{ lead: LeadWithRelations; isNew: boolean }> {
  const existing = await prisma.lead.findUnique({
    where: { messengerPsid: psid },
    include: { quotes: { orderBy: { createdAt: 'desc' } } },
  });
  if (existing) {
    return { lead: existing, isNew: false };
  }

  const created = await prisma.lead.create({
    data: {
      channel: 'messenger',
      messengerPsid: psid,
      stage: 'awaiting_photos',
    },
    include: { quotes: { orderBy: { createdAt: 'desc' } } },
  });

  return { lead: created, isNew: true };
}

export function buildAgentInput({
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

async function processMessengerEvent(event: MessengerEvent, log: Logger) {
  const psid = event.sender.id;
  const message = event.message;
  const postbackPayload = event.postback?.payload;

  if (!message && !postbackPayload) {
    return;
  }

  const attachments =
    message?.attachments
      ?.filter((attachment) => attachment.type === 'image')
      .map((attachment) => attachment.payload.url)
      .filter((url): url is string => Boolean(url)) ?? [];

  const textPayload =
    message?.quick_reply?.payload ??
    sanitizeText(message?.text) ??
    postbackPayload ??
    (attachments.length > 0 ? '[photos uploaded]' : null);

  if (!textPayload) {
    return;
  }

  const { lead, isNew } = await ensureLead(psid);

  const attachmentHistory = await recordLeadAttachments(
    lead.id,
    attachments,
    'messenger',
  );
  const referencesPhotos = PHOTO_REFERENCE_REGEX.test(textPayload.toLowerCase());
  let attachmentsForContext: string[] = [];
  if (attachments.length > 0) {
    attachmentsForContext =
      attachmentHistory.length > 0 ? attachmentHistory : attachments;
  } else if (referencesPhotos && attachmentHistory.length > 0) {
    attachmentsForContext = attachmentHistory;
  }

  const lowerText = textPayload.toLowerCase();
  const curbsideDetected = CURBSIDE_KEYWORDS.some((keyword) =>
    lowerText.includes(keyword),
  );

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      curbside: curbsideDetected ? true : lead.curbside,
      lastCustomerMessageAt: new Date(),
    },
  });

  if (curbsideDetected) {
    lead.curbside = true;
  }

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'customer',
      action: 'customer_message',
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

  const start = Date.now();
  log.info(
    {
      leadId: lead.id,
      psid,
      isNewLead: isNew,
      message: textPayload,
      attachmentCount: attachments.length,
      attachmentHistoryCount: attachmentsForContext.length,
    },
    'Messenger event received; starting agent run.',
  );

  void maybeRunVisionAutomation({
    lead,
    attachments: attachmentsForContext,
    channel: 'messenger',
  }).catch((error) => {
    log.error(
      { err: error, leadId: lead.id },
      'Auto vision analysis failed',
    );
  });

  try {
    await runner.run(agent, inputText, {
      context: {
        leadId: lead.id,
        messengerPsid: psid,
        attachments: attachmentsForContext,
      },
    });
    log.info(
      {
        leadId: lead.id,
        psid,
        durationMs: Date.now() - start,
        attachmentsAnalyzed: attachmentsForContext.length,
      },
      'Agent run completed.',
    );
  } catch (error) {
    log.error(
      {
        leadId: lead.id,
        psid,
        durationMs: Date.now() - start,
        err: error,
      },
      'Agent run failed',
    );
    throw error;
  }
}

async function handleMessengerPost(
  request: FastifyRequest<{ Body: MessengerWebhookPayload }>,
  reply: FastifyReply,
) {
  const body = request.body;
  if (body.object !== 'page') {
    return reply.code(404).send({ error: 'Unsupported object' });
  }

  const events =
    body.entry?.flatMap((entry) => entry.messaging ?? []).filter(Boolean) ??
    [];

  // Process asynchronously so webhook returns fast and we can add human-like
  // delays before replying without risking Facebook timeouts.
  for (const event of events) {
    // Fire and forget with error logging.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    processMessengerEvent(event, request.log).catch((error) => {
      request.log.error({ err: error }, 'Messenger event processing failed');
    });
  }

  return reply.send({ status: 'queued' });
}

async function handleMessengerVerify(
  request: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
) {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];
  const verifyToken = process.env.FB_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    return reply.code(200).send(challenge);
  }

  return reply.code(403).send('Verification failed');
}

export async function messengerRoutes(fastify: FastifyInstance) {
  fastify.get('/api/messenger', handleMessengerVerify);
  fastify.post('/api/messenger', handleMessengerPost);
}
