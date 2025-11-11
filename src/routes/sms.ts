import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';

import { getJunkQuoteAgent } from '../agent/index.ts';
import { buildAgentRunContext, getRunner } from '../lib/agent-runner.ts';
import { createJobDirect } from '../tools/create-job.ts';
import {
  getTenantTimeZone,
  isContextMemoryEnabled,
  isStrictAddressConfirmationEnabled,
} from '../lib/config.ts';
import { prisma } from '../lib/prisma.ts';
import {
  sendSmsMessage,
  validateTwilioSignature,
} from '../adapters/twilio.ts';
import { recordLeadAttachments } from '../lib/attachments.ts';
import { maybeRunVisionAutomation } from '../lib/vision-automation.ts';
import { isAgentPaused } from '../lib/agent-state.ts';
import type { ContextCandidate, ProposedSlot } from '../lib/types.ts';
import { proposeSlotsDirect } from '../tools/propose-slots.ts';
import { resolvePreferredDateTime } from '../lib/date-parser.ts';
import {
  readSchedulingState,
  writeSchedulingState,
} from '../lib/scheduling-state.ts';
import { matchSlotSelection } from '../lib/slot-selection.ts';
import { extractProposedSlots } from '../lib/proposed-slots.ts';
import { confirmSlotDirect } from '../tools/confirm-slot.ts';
import { recordJobEvent } from '../tools/record-job-event.ts';
import { buildBookingConfirmationText } from '../lib/booking.ts';
import {
  buildAddressConfirmPrompt,
  fetchContextCandidates,
  getAmbiguousContextCandidates,
  parseContextConfirmationInput,
  serializeCandidate,
  deserializeCandidate,
  summarizeCandidateOption,
  type ContextConfirmationChoice,
} from '../lib/context.ts';
import {
  ContextMemoryState,
  readContextMemoryState,
  writeContextMemoryState,
} from '../lib/context-memory.ts';

type LeadWithRelations = Prisma.LeadGetPayload<{
  include: { quotes: { orderBy: { createdAt: 'desc' } } };
}>;

type ConversationRecord = Prisma.ConversationGetPayload<{}>;

type TwilioWebhookBody = {
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  [key: `MediaUrl${number}`]: string | undefined;
  [key: string]: unknown;
};

const CURBSIDE_KEYWORDS = ['curbside', 'driveway', 'garage', 'staged'];

const SMS_CONFIRMATION_TEXT_MAP: Record<ContextConfirmationChoice, string> = {
  yes: 'Yes, that is the same address.',
  no: 'No, that is not the same address.',
  different: 'Different address.',
};

type SmsLogger = Pick<FastifyRequest['log'], 'info' | 'warn' | 'error'>;

type SmsContextDecision = {
  stopProcessing: boolean;
  overrideText?: string;
};

type SmsSchedulingDecision = {
  stopProcessing: boolean;
  overrideText?: string;
};

const SCHEDULING_KEYWORDS = [
  'schedule',
  'pickup',
  'pick up',
  'book',
  'booking',
  'slot',
  'window',
  'available',
  'availability',
  'time',
  'day',
];

const STREET_SUFFIXES = [
  'st',
  'street',
  'rd',
  'road',
  'dr',
  'drive',
  'ln',
  'lane',
  'ave',
  'avenue',
  'blvd',
  'boulevard',
  'ct',
  'court',
  'hwy',
  'highway',
  'trl',
  'trail',
  'pkwy',
  'parkway',
  'way',
];

type SmsCandidateSelectionResult = {
  candidate: ContextCandidate;
  index: number;
};

type SmsCandidateSearchResult = {
  candidate: ContextCandidate | null;
  disambiguation: ContextCandidate[];
};

function readSmsPendingCandidateOptions(
  state: ContextMemoryState,
): ContextCandidate[] {
  const raw = state.pending_candidate_options;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (typeof entry !== 'string') {
        return null;
      }
      return deserializeCandidate(entry);
    })
    .filter((candidate): candidate is ContextCandidate => Boolean(candidate));
}

function parseSmsCandidateSelectionInput({
  text,
  options,
}: {
  text: string | null;
  options: ContextCandidate[];
}): SmsCandidateSelectionResult | null {
  if (!text || !options.length) {
    return null;
  }
  const normalized = text.trim().toLowerCase();
  if (/^(1|one|first)[\s.:]?/.test(normalized) && options[0]) {
    return { candidate: options[0], index: 0 };
  }
  if (/^(2|two|second)[\s.:]?/.test(normalized) && options[1]) {
    return { candidate: options[1], index: 1 };
  }
  return null;
}

function buildSmsCandidateOptionsPrompt(options: ContextCandidate[]): string {
  const lines = options.map(
    (candidate, index) => `${index + 1}) ${summarizeCandidateOption(candidate)}`,
  );
  return ['I see a couple past jobs. Which one is this about?']
    .concat(lines)
    .concat('Reply 1, 2, or “different”.')
    .join('\n');
}

async function sendSmsCandidateOptionsPrompt({
  to,
  options,
}: {
  to: string;
  options: ContextCandidate[];
}): Promise<string> {
  const prompt = buildSmsCandidateOptionsPrompt(options);
  await sendSmsMessage(to, prompt);
  return prompt;
}

function isAwaitingSmsAddress(state: ContextMemoryState): boolean {
  return Boolean(state.awaiting_new_address);
}

function getSmsAddressPromptAttempts(state: ContextMemoryState): number {
  const attempts = state.awaiting_address_attempts;
  if (typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 0) {
    return attempts;
  }
  return 0;
}

async function promptSmsForAddress({
  to,
  conversation,
  contextState,
}: {
  to: string;
  conversation: ConversationRecord;
  contextState: ContextMemoryState;
}): Promise<ContextMemoryState> {
  const attempts = getSmsAddressPromptAttempts(contextState);
  const example = '123 Main St, Springfield, MA';
  const text =
    attempts > 0
      ? `Still need the pickup address. Please text it like “${example}”.`
      : `What address should we use? (Example: ${example})`;
  await sendSmsMessage(to, text);
  const nextState: ContextMemoryState = {
    ...contextState,
    awaiting_new_address: true,
    awaiting_address_attempts: attempts + 1,
    awaiting_address_prompted_at: new Date().toISOString(),
    pending_candidate_id: null,
    pending_candidate_prompt: null,
    pending_candidate_summary: null,
    pending_candidate_address: null,
    pending_candidate_snapshot: null,
    pending_candidate_options: [],
  };
  conversation.metadata = await writeContextMemoryState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState,
  });
  return nextState;
}

async function handleSmsAddressCapture({
  messageText,
  lead,
  fromNumber,
  conversation,
  contextState,
}: {
  messageText: string;
  lead: LeadWithRelations;
  fromNumber: string;
  conversation: ConversationRecord;
  contextState: ContextMemoryState;
}): Promise<{ contextState: ContextMemoryState; stopProcessing: boolean; overrideText?: string }> {
  const extracted = maybeExtractAddress(messageText);
  if (!extracted) {
    const nextState = await promptSmsForAddress({
      to: fromNumber,
      conversation,
      contextState,
    });
    return { contextState: nextState, stopProcessing: true };
  }
  if (extracted !== lead.address?.trim()) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { address: extracted },
    });
    lead.address = extracted;
  }
  const nextState: ContextMemoryState = {
    ...contextState,
    awaiting_new_address: false,
    awaiting_address_attempts: 0,
    awaiting_address_prompted_at: null,
  };
  conversation.metadata = await writeContextMemoryState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState,
  });
  await sendSmsMessage(fromNumber, 'Thanks! I’ll use that address for this job.');
  return {
    contextState: nextState,
    stopProcessing: false,
    overrideText: `Address confirmed: ${extracted}`,
  };
}

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

async function recordSmsInboundMessage({
  conversation,
  content,
  fromNumber,
  toNumber,
  attachments,
}: {
  conversation: ConversationRecord;
  content: string;
  fromNumber: string;
  toNumber?: string;
  attachments: string[];
}): Promise<void> {
  const createdAt = new Date();
  const metadata: Prisma.JsonObject = {
    source: 'live',
    direction: 'inbound',
    channel: 'sms',
    from: fromNumber,
  };
  if (toNumber) {
    metadata.to = toNumber;
  }
  if (attachments.length > 0) {
    metadata.attachments = attachments;
  }
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content,
      metadata,
      createdAt,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: createdAt },
  });
  conversation.lastMessageAt = createdAt;
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

async function maybeHandleSmsContextGating({
  lead,
  conversation,
  messageText,
  fromNumber,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  messageText: string;
  fromNumber: string;
  log: SmsLogger;
}): Promise<SmsContextDecision> {
  if (
    !isContextMemoryEnabled() ||
    !isStrictAddressConfirmationEnabled() ||
    !lead.customerId
  ) {
    return { stopProcessing: false };
  }

  let contextState = readContextMemoryState(conversation.metadata);

  if (isAwaitingSmsAddress(contextState)) {
    const result = await handleSmsAddressCapture({
      messageText,
      lead,
      fromNumber,
      conversation,
      contextState,
    });
    contextState = result.contextState;
    if (result.stopProcessing) {
      return { stopProcessing: true };
    }
    return { stopProcessing: false, overrideText: result.overrideText };
  }

  const pendingOptions = readSmsPendingCandidateOptions(contextState);
  const selection = parseSmsCandidateSelectionInput({
    text: messageText,
    options: pendingOptions,
  });
  if (selection) {
    const selected = selection.candidate;
    const selectionState: ContextMemoryState = {
      ...contextState,
      pending_candidate_id: selected.id,
      pending_candidate_prompt: buildAddressConfirmPrompt(selected),
      pending_candidate_summary: selected.summary,
      pending_candidate_address: selected.addressLine ?? null,
      pending_sent_at: new Date().toISOString(),
      pending_candidate_snapshot: JSON.stringify(serializeCandidate(selected)),
      pending_candidate_options: [],
    };
    conversation.metadata = await writeContextMemoryState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState: selectionState,
    });
    contextState = selectionState;
    const updated = await handleSmsContextConfirmationChoice({
      choice: 'yes',
      lead,
      candidateId: selected.id,
      conversation,
      contextState,
      log,
    });
    contextState = updated;
    return { stopProcessing: false, overrideText: confirmationText('yes') };
  }

  const pendingCandidateId = getStringField(contextState, 'pending_candidate_id');
  const choice = parseContextConfirmationInput(null, messageText);

  if (choice && pendingCandidateId) {
    const updated = await handleSmsContextConfirmationChoice({
      choice,
      lead,
      candidateId: pendingCandidateId,
      conversation,
      contextState,
      log,
    });
    contextState = updated;
    if (choice === 'different') {
      contextState = await promptSmsForAddress({
        to: fromNumber,
        conversation,
        contextState,
      });
      return { stopProcessing: true };
    }
    return { stopProcessing: false, overrideText: confirmationText(choice) };
  }

  if (choice) {
    if (choice === 'different') {
      contextState = await promptSmsForAddress({
        to: fromNumber,
        conversation,
        contextState,
      });
      return { stopProcessing: true };
    }
    return { stopProcessing: false, overrideText: confirmationText(choice) };
  }

  if (pendingOptions.length) {
    const prompt = await sendSmsCandidateOptionsPrompt({
      to: fromNumber,
      options: pendingOptions,
    });
    const nextState: ContextMemoryState = {
      ...contextState,
      pending_candidate_prompt: prompt,
      pending_sent_at: new Date().toISOString(),
    };
    conversation.metadata = await writeContextMemoryState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState,
    });
    return { stopProcessing: true };
  }

  if (pendingCandidateId) {
    const prompt = getStringField(contextState, 'pending_candidate_prompt');
    if (prompt) {
      const sent = await sendContextPromptSms(
        fromNumber,
        `${prompt} Reply YES, NO, or DIFFERENT.`,
        log,
      );
      if (!sent) {
        return { stopProcessing: false };
      }
    }
    return { stopProcessing: true };
  }

  if (!messageText || messageText === '[photos uploaded]') {
    return { stopProcessing: false };
  }

  const searchResult = await findNextSmsContextCandidate({
    customerId: lead.customerId,
    messageText,
    contextState,
    log,
  });

  if (searchResult.disambiguation.length >= 2) {
    const prompt = await sendSmsCandidateOptionsPrompt({
      to: fromNumber,
      options: searchResult.disambiguation,
    });
    const serialized = searchResult.disambiguation.map((candidate) =>
      JSON.stringify(serializeCandidate(candidate)),
    );
    const nextState: ContextMemoryState = {
      ...contextState,
      pending_candidate_id: null,
      pending_candidate_prompt: prompt,
      pending_candidate_summary: null,
      pending_candidate_address: null,
      pending_sent_at: new Date().toISOString(),
      pending_candidate_snapshot: null,
      pending_candidate_options: serialized,
    };
    conversation.metadata = await writeContextMemoryState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState,
    });
    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'context_prompted',
        payload: {
          candidate_ids: searchResult.disambiguation.map((candidate) => candidate.id),
          summaries: searchResult.disambiguation.map((candidate) => candidate.summary),
          mode: 'disambiguation',
        } as Prisma.JsonObject,
      },
    });
    return { stopProcessing: true };
  }

  const candidate = searchResult.candidate;

  if (!candidate) {
    return { stopProcessing: false };
  }

  const prompt = `${buildAddressConfirmPrompt(
    candidate,
  )} Reply YES, NO, or DIFFERENT so I know whether to reuse it.`;
  const sent = await sendContextPromptSms(fromNumber, prompt, log);
  if (!sent) {
    return { stopProcessing: false };
  }

  const nextState: ContextMemoryState = {
    ...contextState,
    pending_candidate_id: candidate.id,
    pending_candidate_prompt: prompt,
    pending_candidate_summary: candidate.summary,
    pending_candidate_address: candidate.addressLine ?? null,
    pending_sent_at: new Date().toISOString(),
    pending_candidate_snapshot: JSON.stringify(serializeCandidate(candidate)),
    pending_candidate_options: [],
  };

  conversation.metadata = await writeContextMemoryState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState,
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'system',
      action: 'context_prompted',
      payload: {
        candidate_id: candidate.id,
        summary: candidate.summary,
        address: candidate.addressLine ?? null,
      } as Prisma.JsonObject,
    },
  });

  return { stopProcessing: true };
}

async function handleSmsContextConfirmationChoice({
  choice,
  lead,
  candidateId,
  conversation,
  contextState,
  log,
}: {
  choice: ContextConfirmationChoice;
  lead: LeadWithRelations;
  candidateId: string;
  conversation: ConversationRecord;
  contextState: ContextMemoryState;
  log: SmsLogger;
}): Promise<ContextMemoryState> {
  const baseState: ContextMemoryState = {
    ...contextState,
    pending_candidate_id: null,
    pending_candidate_prompt: null,
    pending_candidate_summary: null,
    pending_candidate_address: null,
    pending_sent_at: null,
    pending_candidate_snapshot: null,
    pending_candidate_options: [],
  };

  if (choice === 'yes') {
    const confirmed = new Set(getStringArrayField(contextState, 'confirmed_candidate_ids'));
    confirmed.add(candidateId);
    const dismissed = getStringArrayField(contextState, 'dismissed_candidate_ids').filter(
      (id) => id !== candidateId,
    );
    const createdJobId = await maybeCreateJobFromCandidate({
      lead,
      candidateSnapshotJson: contextState.pending_candidate_snapshot,
      log,
    });
    const nextState: ContextMemoryState = {
      ...baseState,
      confirmed_candidate_ids: Array.from(confirmed),
      dismissed_candidate_ids: dismissed,
      confirmed_at: new Date().toISOString(),
      latest_context_job_id: createdJobId ?? getStringField(contextState, 'latest_context_job_id'),
      awaiting_new_address: false,
      awaiting_address_attempts: 0,
      awaiting_address_prompted_at: null,
    };
    conversation.metadata = await writeContextMemoryState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState,
    });
    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'context_confirmed',
        payload: {
          candidate_id: candidateId,
        } as Prisma.JsonObject,
      },
    });
    return nextState;
  }

  const dismissed = new Set(getStringArrayField(contextState, 'dismissed_candidate_ids'));
  dismissed.add(candidateId);
  const awaitingAddress = choice === 'different';
  const nextState: ContextMemoryState = {
    ...baseState,
    dismissed_candidate_ids: Array.from(dismissed),
    latest_context_job_id: getStringField(contextState, 'latest_context_job_id'),
    awaiting_new_address: awaitingAddress,
    awaiting_address_attempts: awaitingAddress
      ? getSmsAddressPromptAttempts(contextState)
      : 0,
    awaiting_address_prompted_at: awaitingAddress
      ? contextState.awaiting_address_prompted_at ?? null
      : null,
  };

  conversation.metadata = await writeContextMemoryState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState,
  });

  await prisma.audit.create({
    data: {
      leadId: lead.id,
      actor: 'system',
      action: 'context_declined',
      payload: {
        candidate_id: candidateId,
        reason: choice,
      } as Prisma.JsonObject,
    },
  });

  return nextState;
}

async function findNextSmsContextCandidate({
  customerId,
  messageText,
  contextState,
  log,
}: {
  customerId: string;
  messageText: string;
  contextState: ContextMemoryState;
  log: SmsLogger;
}): Promise<SmsCandidateSearchResult> {
  try {
    const candidates = await fetchContextCandidates(customerId, messageText, 5);
    const dismissed = new Set(getStringArrayField(contextState, 'dismissed_candidate_ids'));
    const confirmed = new Set(getStringArrayField(contextState, 'confirmed_candidate_ids'));
    const eligible = candidates.filter(
      (candidate) => !dismissed.has(candidate.id) && !confirmed.has(candidate.id),
    );
    if (eligible.length === 0) {
      return { candidate: null, disambiguation: [] };
    }
    const disambiguation = getAmbiguousContextCandidates(eligible);
    if (disambiguation.length >= 2) {
      return { candidate: null, disambiguation };
    }
    return { candidate: eligible[0], disambiguation: [] };
  } catch (error) {
    log.warn({ err: error }, 'Failed to fetch SMS context candidates.');
    return { candidate: null, disambiguation: [] };
  }
}

function getStringArrayField(state: ContextMemoryState, key: string): string[] {
  const value = state[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function getStringField(state: ContextMemoryState, key: string): string | null {
  const value = state[key];
  return typeof value === 'string' ? value : null;
}

function confirmationText(choice: ContextConfirmationChoice): string {
  return SMS_CONFIRMATION_TEXT_MAP[choice];
}

function getContextBasis(contextState: ContextMemoryState): string | undefined {
  const confirmed = getStringArrayField(contextState, 'confirmed_candidate_ids');
  if (confirmed.length > 0) {
    return 'prior_job_context_confirmed';
  }
  return undefined;
}

async function sendContextPromptSms(
  to: string,
  body: string,
  log: SmsLogger,
): Promise<boolean> {
  try {
    await sendSmsMessage(to, body);
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Failed to send SMS context prompt.');
    return false;
  }
}

async function maybeCreateJobFromCandidate({
  lead,
  candidateSnapshotJson,
  log,
}: {
  lead: LeadWithRelations;
  candidateSnapshotJson: string | null | undefined;
  log: SmsLogger;
}): Promise<string | null> {
  if (!candidateSnapshotJson || !lead.customerId) {
    return null;
  }
  const candidate = deserializeCandidate(candidateSnapshotJson);
  if (!candidate) {
    return null;
  }
  try {
    const job = await createJobDirect({
      customer_id: lead.customerId,
      lead_id: lead.id,
      address_id: candidate.addressId ?? undefined,
      title: buildAutoJobTitle(candidate),
      description: buildAutoJobDescription(candidate),
      category: candidate.category ?? undefined,
      scheduled_date: candidate.lastInteractionAt.toISOString(),
    });
    await recordJobEvent({
      job_id: job.job_id,
      type: 'quoted',
      payload: {
        basis: 'prior_job_context_confirmed',
        candidate_id: candidate.id,
      },
    });
    return job.job_id;
  } catch (error) {
    log.warn({ err: error }, 'Failed to create job from confirmed context.');
    return null;
  }
}

function buildAutoJobTitle(candidate: ContextCandidate): string {
  if (candidate.summary) {
    return candidate.summary.slice(0, 80);
  }
  return candidate.source === 'job' ? 'Returning pickup' : 'Follow-up conversation';
}

function buildAutoJobDescription(candidate: ContextCandidate): string {
  const parts = [
    candidate.summary ?? 'Returning customer request.',
    candidate.addressLine ? `Address: ${candidate.addressLine}.` : null,
    `Source: ${candidate.source}.`,
  ].filter(Boolean);
  return parts.join(' ');
}

async function maybeHandleSmsScheduling({
  lead,
  conversation,
  messageText,
  fromNumber,
  timeZone,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  messageText: string;
  fromNumber: string;
  timeZone: string;
  log: SmsLogger;
}): Promise<SmsSchedulingDecision> {
  const schedulingState = readSchedulingState(conversation.metadata);
  const pendingConfirmation = schedulingState.pending_confirmation ?? null;

  if (pendingConfirmation) {
    const choice = parseContextConfirmationInput(null, messageText);
    if (choice) {
      return handleSmsSchedulingConfirmationChoice({
        choice,
        lead,
        conversation,
        schedulingState,
        pendingConfirmation,
        fromNumber,
        timeZone,
        log,
      });
    }
  }

  const schedulingIntent = detectSchedulingIntent(messageText, timeZone);
  if (!schedulingIntent) {
    return { stopProcessing: false };
  }

  await sendSmsMessage(
    fromNumber,
    `Targeting ${schedulingIntent.label}? Reply YES to confirm or NO for another time.`,
  );

  const nextState: SchedulingState = {
    ...schedulingState,
    pending_confirmation: {
      iso: schedulingIntent.iso,
      label: schedulingIntent.label,
      prompt: schedulingIntent.label,
      preferred_text: schedulingIntent.preferredText,
      timeZone,
    },
  };
  conversation.metadata = await writeSchedulingState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState,
  });

  return { stopProcessing: true };
}

async function handleSmsSchedulingConfirmationChoice({
  choice,
  lead,
  conversation,
  schedulingState,
  pendingConfirmation,
  fromNumber,
  timeZone,
  log,
}: {
  choice: ContextConfirmationChoice;
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  schedulingState: SchedulingState;
  pendingConfirmation: NonNullable<SchedulingState['pending_confirmation']>;
  fromNumber: string;
  timeZone: string;
  log: SmsLogger;
}): Promise<SmsSchedulingDecision> {
  const baseState: SchedulingState = {
    ...schedulingState,
    pending_confirmation: null,
  };

  if (choice === 'yes') {
    const handled = await sendSmsSlotsForDate({
      lead,
      conversation,
      iso: pendingConfirmation.iso,
      preferredText: pendingConfirmation.preferred_text ?? null,
      fromNumber,
      timeZone,
      schedulingState: baseState,
      log,
    });
    return { stopProcessing: handled };
  }

  if (choice === 'different') {
    await sendSmsMessage(fromNumber, 'Sure thing—what day and time should we aim for?');
    conversation.metadata = await writeSchedulingState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState: baseState,
    });
    return { stopProcessing: true };
  }

  await sendSmsMessage(
    fromNumber,
    'Okay! Just text me the day and time that works best and I’ll check availability.',
  );
  conversation.metadata = await writeSchedulingState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState: baseState,
  });
  return { stopProcessing: true };
}

async function sendSmsSlotsForDate({
  lead,
  conversation,
  iso,
  preferredText,
  fromNumber,
  timeZone,
  schedulingState,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  iso: string;
  preferredText: string | null;
  fromNumber: string;
  timeZone: string;
  schedulingState: SchedulingState;
  log: SmsLogger;
}): Promise<boolean> {
  try {
    const result = await proposeSlotsDirect({
      lead_id: lead.id,
      preferred_day: iso,
      preferred_time_text: preferredText ?? undefined,
    });
    let slots = result.slots;
    let header = `Openings near ${formatScheduleLabel(new Date(iso), timeZone)}:`;

    if (!slots.length) {
      const fallback = await proposeSlotsDirect({
        lead_id: lead.id,
        preferred_day: undefined,
        preferred_time_text: undefined,
      });
      if (!fallback.slots.length) {
        await sendSmsMessage(fromNumber, 'No openings near that time. Want to try another day?');
        conversation.metadata = await writeSchedulingState({
          conversationId: conversation.id,
          existingMetadata: conversation.metadata,
          nextState: schedulingState,
        });
        return true;
      }
      slots = fallback.slots;
      header = 'No openings at that time, but the soonest windows are:';
    }
    const lines = slots.slice(0, 3).map((slot, index) => `${index + 1}) ${formatSlotLabel(slot)}`);
    const text = [header]
      .concat(lines)
      .concat('Reply with the option that fits or another time.')
      .join('\n');
    await sendSmsMessage(fromNumber, text);
    const nextState: SchedulingState = {
      ...schedulingState,
      pending_confirmation: null,
      last_slots_prompt_at: new Date().toISOString(),
      last_slots_prompt_text: text,
    };
    conversation.metadata = await writeSchedulingState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState,
    });
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Failed to auto-propose SMS slots.');
    return false;
  }
}

function detectSchedulingIntent(
  text: string | null,
  timeZone: string,
): { iso: string; label: string; preferredText: string } | null {
  if (!text) {
    return null;
  }
  const normalized = text.toLowerCase();
  const keywordHit = SCHEDULING_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
  if (!keywordHit) {
    return null;
  }
  const resolved = resolvePreferredDateTime(text, timeZone);
  if (!resolved) {
    return null;
  }
  const iso = resolved.toISOString();
  const label = formatScheduleLabel(resolved, timeZone);
  return { iso, label, preferredText: text };
}

function maybeExtractAddress(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  if (!/\d/.test(trimmed)) return null;
  if (!/[a-zA-Z]/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const hasStreetSuffix = STREET_SUFFIXES.some((suffix) => {
    return (
      lower.includes(` ${suffix} `) ||
      lower.endsWith(` ${suffix}`) ||
      lower.includes(` ${suffix},`)
    );
  });
  if (!hasStreetSuffix) {
    return null;
  }
  return trimmed.replace(/\s+/g, ' ').trim();
}

function formatScheduleLabel(date: Date, timeZone: string): string {
  const dt = DateTime.fromJSDate(date, { zone: timeZone });
  return dt.toFormat('ccc MMM d h:mm a');
}

function formatSlotLabel(slot: ProposedSlot): string {
  const start = DateTime.fromISO(slot.window_start).setZone('America/New_York');
  const end = DateTime.fromISO(slot.window_end).setZone('America/New_York');
  if (!start.isValid || !end.isValid) {
    return slot.label ?? slot.id;
  }
  return `${start.toFormat('ccc MMM d h:mm a')}–${end.toFormat('h:mm a')}`;
}

async function maybeHandleSmsSlotSelection({
  slotMatch,
  lead,
  fromNumber,
  timeZone,
  log,
  conversation,
}: {
  slotMatch: ReturnType<typeof matchSlotSelection>;
  lead: LeadWithRelations;
  fromNumber: string;
  timeZone: string;
  log: SmsLogger;
  conversation: ConversationRecord;
}): Promise<boolean> {
  if (!slotMatch) {
    return false;
  }
  try {
    const result = await confirmSlotDirect({
      lead_id: lead.id,
      slot: slotMatch.slot,
      quote_id: lead.quotes[0]?.id,
      notes: undefined,
      address: lead.address ?? undefined,
    });

    if ('needs_address' in result) {
      await sendSmsMessage(fromNumber, result.message);
      return true;
    }

    const eventPayload: Record<string, unknown> = {
      slot_id: slotMatch.slot.id,
      channel: 'sms',
    };
    const basis = getContextBasis(readContextMemoryState(conversation.metadata));
    if (basis) {
      eventPayload.basis = basis;
    }
    await recordJobEvent({
      job_id: result.job_id,
      type: 'scheduled',
      payload: eventPayload as Prisma.JsonObject,
    }).catch((error) => {
      log.warn({ err: error }, 'Failed to record job event after SMS confirmation.');
    });

    const resolvedQuote =
      (await prisma.quote.findUnique({ where: { id: result.quote_id } })) ??
      lead.quotes[0] ??
      null;

    const confirmationText = buildBookingConfirmationText({
      windowStartIso: result.window_start,
      windowEndIso: result.window_end,
      address: lead.address ?? '',
      timeZone,
      lowEstimate: resolvedQuote ? resolvedQuote.subtotal.toNumber() : null,
      highEstimate: resolvedQuote ? resolvedQuote.total.toNumber() : null,
    });

    await sendSmsMessage(fromNumber, confirmationText);

    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'slot_confirmed_auto',
        payload: {
          slot_id: slotMatch.slot.id,
          channel: 'sms',
        } as Prisma.JsonObject,
      },
    });

    return true;
  } catch (error) {
    log.error({ err: error }, 'Automatic SMS slot confirmation failed.');
    return false;
  }
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
  let textPayload =
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
  const inboundContent = textPayload;

  await recordSmsInboundMessage({
    conversation,
    content: inboundContent,
    fromNumber: from,
    toNumber: body.To,
    attachments,
  });
  const tenantTimeZone = getTenantTimeZone();

  const contextDecision = await maybeHandleSmsContextGating({
    lead,
    conversation,
    messageText: textPayload,
    fromNumber: from,
    log: request.log,
  });

  if (contextDecision.overrideText) {
    textPayload = contextDecision.overrideText;
  }

  if (contextDecision.stopProcessing) {
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

  const schedulingDecision = await maybeHandleSmsScheduling({
    lead,
    conversation,
    messageText: textPayload,
    fromNumber: from,
    timeZone: tenantTimeZone,
    log: request.log,
  });

  if (schedulingDecision.overrideText) {
    textPayload = schedulingDecision.overrideText;
  }

  if (schedulingDecision.stopProcessing) {
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

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

  const metadata = (lead.stateMetadata as Prisma.JsonValue | null) ?? null;
  const proposedSlots = extractProposedSlots(metadata);
  const slotMatch =
    proposedSlots.length > 0
      ? matchSlotSelection({
          text: textPayload,
          slots: proposedSlots,
          timeZone: tenantTimeZone,
        })
      : null;
  if (slotMatch) {
    request.log.info(
      {
        leadId: lead.id,
        slotId: slotMatch.slot.id,
        reason: slotMatch.reason,
      },
      'Detected slot selection from SMS message.',
    );
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

  const slotHandled = await maybeHandleSmsSlotSelection({
    slotMatch,
    lead,
    fromNumber: from,
    timeZone: tenantTimeZone,
    log: request.log,
    conversation,
  });
  if (slotHandled) {
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

  if (await isAgentPaused()) {
    request.log.info(
      { leadId: lead.id, from },
      'Agent is paused; skipping SMS automation.',
    );
    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'agent_paused_skip',
        payload: {
          channel: 'sms',
          text: textPayload,
        } as Prisma.JsonObject,
      },
    });
    reply.type('text/xml').send('<Response></Response>');
    return;
  }

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

  const timeZone = tenantTimeZone;
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
