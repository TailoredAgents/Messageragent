import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';

import { getJunkQuoteAgent } from '../agent/index.ts';
import { sendMessengerMessage } from '../adapters/messenger.ts';
import { buildAgentRunContext, getRunner } from '../lib/agent-runner.ts';
import { createJobDirect } from '../tools/create-job.ts';
import {
  getTenantTimeZone,
  isContextMemoryEnabled,
  isStrictAddressConfirmationEnabled,
} from '../lib/config.ts';
import { prisma } from '../lib/prisma.ts';
import { recordLeadAttachments } from '../lib/attachments.ts';
import { maybeRunVisionAutomation } from '../lib/vision-automation.ts';
import { matchSlotSelection } from '../lib/slot-selection.ts';
import { getCalendarConfig } from '../lib/google-calendar.ts';
import { expandTimeShorthand, normalizeForIntent } from '../lib/text-normalize.ts';
import {
  ADDRESS_CONFIRM_DIFFERENT,
  ADDRESS_CONFIRM_YES,
  getAmbiguousContextCandidates,
  buildAddressConfirmPrompt,
  fetchContextCandidates,
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
import { ProposedSlot, type ContextCandidate } from '../lib/types.ts';
import { extractProposedSlots } from '../lib/proposed-slots.ts';
import { confirmSlotDirect } from '../tools/confirm-slot.ts';
import { recordJobEvent } from '../tools/record-job-event.ts';
import { buildBookingConfirmationText } from '../lib/booking.ts';
import { proposeSlotsDirect } from '../tools/propose-slots.ts';
import { resolvePreferredDateTime } from '../lib/date-parser.ts';
import {
  readSchedulingState,
  writeSchedulingState,
  type SchedulingState,
} from '../lib/scheduling-state.ts';
import { isAgentPaused } from '../lib/agent-state.ts';
import {
  maskText,
  wrapFastifyLogger,
  type LoggerInstance,
} from '../lib/log.ts';

type LeadWithRelations = Prisma.LeadGetPayload<{
  include: { quotes: { orderBy: { createdAt: 'desc' } } };
}>;

type ConversationRecord = Prisma.ConversationGetPayload<{}>;

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

const ADDRESS_CONFIRMATION_REPLIES = [
  { title: 'Yes', payload: ADDRESS_CONFIRM_YES },
  { title: 'New address', payload: ADDRESS_CONFIRM_DIFFERENT },
] as const;

const CONFIRMATION_TEXT_MAP: Record<ContextConfirmationChoice, string> = {
  yes: 'Yes, that is the same address.',
  different: 'New address.',
};

const SLOT_SELECT_PREFIX = 'SLOT_SELECT|';
const SCHED_CONFIRM_YES = 'SCHED_CONFIRM_YES';
const SCHED_CONFIRM_NO = 'SCHED_CONFIRM_NO';
const SCHED_CONFIRM_DIFFERENT = 'SCHED_CONFIRM_DIFFERENT';
const ADDRESS_SELECT_PREFIX = 'ADDRESS_SELECT|';
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
  // Added slang/shorthand for real-world phrasing
  'asap',
  'soonest',
  'today',
  'tonight',
  'tomorrow',
  'tmrw',
  'weekend',
  'next',
  'morning',
  'afternoon',
  'evening',
  'saturday',
  'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
];

const RUN_ID_PREFIX = 'messenger';

function buildRunId(): string {
  return `${RUN_ID_PREFIX}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function fingerprintPsid(psid: string): string {
  if (!psid) {
    return '[redacted:psid]';
  }
  return `[psid:***${psid.slice(-4)}]`;
}

type RouteLogger = LoggerInstance;

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

async function recordMessengerInboundMessage({
  conversation,
  content,
  attachments,
  quickReplyPayload,
  postbackPayload,
  messengerMid,
  psid,
  timestamp,
}: {
  conversation: ConversationRecord;
  content: string;
  attachments: string[];
  quickReplyPayload: string | null;
  postbackPayload: string | null;
  messengerMid?: string;
  psid: string;
  timestamp?: number;
}): Promise<void> {
  const createdAt =
    typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? new Date(timestamp)
      : new Date();
  const metadata: Prisma.JsonObject = {
    source: 'live',
    direction: 'inbound',
    channel: 'messenger',
    psid,
  };
  if (messengerMid) {
    metadata.messenger_mid = messengerMid;
  }
  if (quickReplyPayload) {
    metadata.quick_reply_payload = quickReplyPayload;
  }
  if (postbackPayload) {
    metadata.postback_payload = postbackPayload;
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

async function processMessengerEvent(
  event: MessengerEvent,
  options: { log: RouteLogger; requestId: string },
) {
  const { log: requestLog, requestId } = options;
  const psid = event.sender.id;
  const runId = buildRunId();
  const eventStart = Date.now();
  const baseLog = requestLog.child({
    channel: 'messenger',
    requestId,
    runId,
    psid_fingerprint: fingerprintPsid(psid),
  });
  const message = event.message;
  const postbackPayload = event.postback?.payload;

  if (!message && !postbackPayload) {
    baseLog.warn({ workflow_step: 'ignored_event' }, 'Messenger event missing payload.');
    return;
  }

  const attachments =
    message?.attachments
      ?.filter((attachment) => attachment.type === 'image')
      .map((attachment) => attachment.payload.url)
      .filter((url): url is string => Boolean(url)) ?? [];

  const quickReplyPayload = message?.quick_reply?.payload ?? null;
  const messageText = sanitizeText(message?.text);

  let textPayload =
    messageText ??
    quickReplyPayload ??
    postbackPayload ??
    (attachments.length > 0 ? '[photos uploaded]' : null);

  if (!textPayload) {
    baseLog.warn(
      {
        workflow_step: 'missing_text',
        attachments_count: attachments.length,
      },
      'Messenger event ignored; no text payload.',
    );
    return;
  }

  const { lead, isNew } = await ensureLead(psid);
  const conversation = await ensureConversation({
    channel: 'messenger',
    externalId: psid,
    leadId: lead.id,
    customerId: lead.customerId,
  });
  const log = baseLog.child({
    leadId: lead.id,
    conversationId: conversation.id,
    customerId: lead.customerId ?? undefined,
  });
  const tenantTimeZone = getTenantTimeZone();
  const inboundContent = textPayload;

  log.info(
    {
      workflow_step: 'inbound_received',
      attachments_count: attachments.length,
      has_quick_reply: Boolean(quickReplyPayload),
      is_new_lead: isNew,
      message_snippet: maskText(textPayload, 'message'),
    },
    'Messenger event received.',
  );

  await recordMessengerInboundMessage({
    conversation,
    content: inboundContent,
    attachments,
    quickReplyPayload,
    postbackPayload,
    messengerMid: message?.mid,
    psid,
    timestamp: event.timestamp,
  });

  const contextDecision = await maybeHandleMessengerContextGating({
    lead,
    conversation,
    messageText: textPayload,
    quickReplyPayload,
    psid,
    log,
  });

  if (contextDecision.overrideText) {
    textPayload = contextDecision.overrideText;
  }

  if (contextDecision.stopProcessing) {
    return;
  }

  const schedulingDecision = await maybeHandleMessengerScheduling({
    lead,
    conversation,
    messageText: textPayload,
    quickReplyPayload,
    psid,
    timeZone: tenantTimeZone,
    log,
  });

  if (schedulingDecision.overrideText) {
    textPayload = schedulingDecision.overrideText;
  }

  if (schedulingDecision.stopProcessing) {
    return;
  }

  const attachmentHistory = await recordLeadAttachments(
    lead.id,
    attachments,
    'messenger',
  );
  const normalizedForIntent = textPayload ? normalizeForIntent(textPayload) : '';
  const referencesPhotos = PHOTO_REFERENCE_REGEX.test(normalizedForIntent);
  let attachmentsForContext: string[] = [];
  if (attachments.length > 0) {
    attachmentsForContext =
      attachmentHistory.length > 0 ? attachmentHistory : attachments;
  } else if (referencesPhotos && attachmentHistory.length > 0) {
    attachmentsForContext = attachmentHistory;
  }

  if (!textPayload) {
    log.warn(
      { workflow_step: 'empty_text_after_override' },
      'Text payload became empty after context/scheduling override',
    );
    return;
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

  const detectedAddress = maybeExtractAddress(textPayload);
  if (detectedAddress) {
    if (detectedAddress !== lead.address?.trim()) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { address: detectedAddress },
      });
      lead.address = detectedAddress;
    }
    log.info(
      {
        workflow_step: 'address_capture',
        address_detected: maskText(detectedAddress, 'address'),
        curbside_detected: curbsideDetected,
      },
      'Captured service address from message.',
    );
  }

  const metadata = (lead.stateMetadata as Prisma.JsonValue | null) ?? null;
  const proposedSlots = extractProposedSlots(metadata);
  const calendarConfig = getCalendarConfig();
  const timeZone = calendarConfig?.timeZone ?? tenantTimeZone;
  const slotMatch =
    proposedSlots.length > 0
      ? matchSlotSelection({
          text: textPayload,
          slots: proposedSlots,
          timeZone,
        })
      : null;
  const automationNotes = buildAutomationHints({
    slotMatch,
    lead,
    message: textPayload,
    proposedSlots,
  });
  if (slotMatch) {
    log.info(
      {
        slotId: slotMatch.slot.id,
        reason: slotMatch.reason,
        workflow_step: 'slot_selection_detected',
      },
      'Detected slot selection from customer message.',
    );
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

  if (contextDecision.stopProcessing) {
    return;
  }

  const slotHandled = await maybeHandleMessengerSlotSelection({
    slotMatch,
    lead,
    psid,
    timeZone,
    log,
    quickReplyPayload,
    proposedSlots,
    conversation,
  });
  if (slotHandled) {
    return;
  }

  if (await isAgentPaused()) {
    log.info(
      { leadId: lead.id, psid },
      'Agent is paused; skipping messenger automation.',
    );
    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'agent_paused_skip',
        payload: {
          channel: 'messenger',
          text: textPayload,
        } as Prisma.JsonObject,
      },
    });
    return;
  }

  const runner = getRunner();
  const agent = getJunkQuoteAgent();

  const inputText = buildAgentInput({
    lead,
    text: textPayload,
    attachments: attachmentsForContext,
  });
  const helperSection = automationNotes.length
    ? buildAutomationNoteSection(automationNotes)
    : null;
  const runnerInput =
    helperSection !== null ? `${helperSection}\n\n${inputText}` : inputText;

  const start = Date.now();
  log.info(
    {
      workflow_step: 'agent_run_start',
      is_new_lead: isNew,
      message_snippet: maskText(textPayload, 'message'),
      attachments_count: attachments.length,
      attachment_history_count: attachmentsForContext.length,
      address_detected: Boolean(detectedAddress),
      curbside_detected: curbsideDetected,
      duration_ms: Date.now() - eventStart,
    },
    'Messenger agent run starting.',
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
    await runner.run(agent, runnerInput, {
      context: buildAgentRunContext({
        leadId: lead.id,
        conversationId: conversation.id,
        customerId: lead.customerId,
        channel: 'messenger',
        timeZone,
        messengerPsid: psid,
        attachments: attachmentsForContext,
        runId,
        requestId,
      }),
    });
    log.info(
      {
        workflow_step: 'agent_run_end',
        duration_ms: Date.now() - start,
        attachments_analyzed: attachmentsForContext.length,
      },
      'Messenger agent run completed.',
    );
  } catch (error) {
    log.error(
      {
        workflow_step: 'agent_run_error',
        duration_ms: Date.now() - start,
        err: error,
      },
      'Agent run failed',
    );
    throw error;
  }
}

function buildAutomationHints({
  slotMatch,
  lead,
  message,
  proposedSlots,
}: {
  slotMatch: ReturnType<typeof matchSlotSelection>;
  lead: LeadWithRelations;
  message: string;
  proposedSlots: ProposedSlot[];
}): string[] {
  const notes: string[] = [];
  if (slotMatch) {
    const label = slotMatch.slot.label || formatSlotLabel(slotMatch.slot);
    const snippet = truncateMessage(message);
    notes.push(
      `Customer message (“${snippet}”) matches slot "${label}". Use confirm_slot with id ${slotMatch.slot.id} if it’s still free.`,
    );
  }
  if (!lead.address) {
    notes.push('No service address captured yet—ask for it before booking.');
  }
  const awaitingSlotSelection =
    !slotMatch &&
    proposedSlots.length > 0 &&
    (!lead.stateMetadata ||
      typeof lead.stateMetadata !== 'object' ||
      !(lead.stateMetadata as Record<string, unknown>).booked_job_id);
  if (awaitingSlotSelection) {
    const lowerMessage = message.toLowerCase();
    const mentionsAccess = CURBSIDE_KEYWORDS.some((keyword) =>
      lowerMessage.includes(keyword),
    );
    const basePrompt =
      'Customer hasn’t picked a window yet. Re-offer the proposed slots or ask which works best, then confirm once they choose.';
    notes.push(
      mentionsAccess
        ? `${basePrompt} They just shared access details, so move the conversation back to scheduling.`
        : basePrompt,
    );
  }
  return notes;
}

function buildAutomationNoteSection(notes: string[]): string {
  return ['Automation hints (internal):', ...notes.map((note) => `- ${note}`)].join(
    '\n',
  );
}

type CandidateSelectionResult = {
  candidate: ContextCandidate;
  index: number;
};

type CandidateSearchResult = {
  candidate: ContextCandidate | null;
  disambiguation: ContextCandidate[];
};

function readPendingCandidateOptions(
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

function parseCandidateSelectionInput({
  payload,
  text,
  options,
}: {
  payload: string | null;
  text: string | null;
  options: ContextCandidate[];
}): CandidateSelectionResult | null {
  if (!options.length) {
    return null;
  }
  if (payload && payload.startsWith(ADDRESS_SELECT_PREFIX)) {
    const candidate = options.find(
      (option) => `${ADDRESS_SELECT_PREFIX}${option.id}` === payload,
    );
    if (candidate) {
      return { candidate, index: options.indexOf(candidate) };
    }
  }
  const normalized = text?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return null;
  }
  if (/^(1|one|first)[\s.:]?/.test(normalized) && options[0]) {
    return { candidate: options[0], index: 0 };
  }
  if (/^(2|two|second)[\s.:]?/.test(normalized) && options[1]) {
    return { candidate: options[1], index: 1 };
  }
  return null;
}

function buildCandidateOptionsPrompt(
  options: ContextCandidate[],
): { text: string; quickReplies: { title: string; payload: string }[] } {
  const lines = options.map(
    (candidate, index) => `${index + 1}) ${summarizeCandidateOption(candidate)}`,
  );
  const text = ['Quick check: which past address is this about?']
    .concat(lines)
    .concat('Reply 1 or 2, or tap “New address”.')
    .join('\n');
  const quickReplies = options.map((candidate, index) => ({
    title: `Option ${index + 1}`,
    payload: `${ADDRESS_SELECT_PREFIX}${candidate.id}`,
  }));
  quickReplies.push({ title: 'New address', payload: ADDRESS_CONFIRM_DIFFERENT });
  return { text, quickReplies };
}

async function sendMessengerCandidateOptionsPrompt({
  psid,
  options,
  log,
}: {
  psid: string;
  options: ContextCandidate[];
  log: RouteLogger;
}): Promise<{ sent: boolean; prompt: string }> {
  const { text, quickReplies } = buildCandidateOptionsPrompt(options);
  try {
    await sendMessengerMessage({
      to: psid,
      text,
      quickReplies,
      jitter: false,
    });
    log.info(
      {
        workflow_step: 'context_prompt_disambiguation',
        candidate_ids: options.map((candidate) => candidate.id),
        candidate_scores: options.map((candidate) => candidate.score),
        prompt_snippet: maskText(text, 'prompt'),
      },
      'Context disambiguation prompt sent.',
    );
    return { sent: true, prompt: text };
  } catch (error) {
    log.error({ err: error }, 'Failed to send Messenger candidate options prompt.');
    return { sent: false, prompt: text };
  }
}

function getAddressPromptAttempts(state: ContextMemoryState): number {
  const attempts = state.awaiting_address_attempts;
  if (typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 0) {
    return attempts;
  }
  return 0;
}

function isAwaitingNewAddress(state: ContextMemoryState): boolean {
  return Boolean(state.awaiting_new_address);
}

async function promptMessengerForAddress({
  psid,
  conversation,
  contextState,
  log,
}: {
  psid: string;
  conversation: ConversationRecord;
  contextState: ContextMemoryState;
  log: RouteLogger;
}): Promise<ContextMemoryState> {
  const attempts = getAddressPromptAttempts(contextState);
  const example = '123 Main St, Springfield, MA';
  const text =
    attempts > 0
      ? `Still need the pickup address. Please send it like “${example}”.`
      : `No problem—what address should we use? (For example: ${example})`;
  await sendMessengerMessage({
    to: psid,
    text,
    jitter: false,
  });
  log.info(
    {
      workflow_step: 'address_prompt',
      attempts: attempts + 1,
      prompt_snippet: maskText(text, 'prompt'),
    },
    'Address prompt sent.',
  );
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

async function handleMessengerAddressCapture({
  messageText,
  lead,
  psid,
  conversation,
  contextState,
  log,
}: {
  messageText: string;
  lead: LeadWithRelations;
  psid: string;
  conversation: ConversationRecord;
  contextState: ContextMemoryState;
  log: RouteLogger;
}): Promise<{
  contextState: ContextMemoryState;
  stopProcessing: boolean;
  overrideText?: string;
}> {
  const extracted = maybeExtractAddress(messageText);
  if (!extracted) {
    const nextState = await promptMessengerForAddress({
      psid,
      conversation,
      contextState,
      log,
    });
    return { contextState: nextState, stopProcessing: true };
  }
  if (extracted !== lead.address?.trim()) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { address: extracted },
    });
    lead.address = extracted;
    log.info(
      {
        workflow_step: 'address_capture',
        address_detected: maskText(extracted, 'address'),
      },
      'Captured address from prompt response.',
    );
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
  await sendMessengerMessage({
    to: psid,
    text: 'Thanks! We’ll use that address for this pickup. What all needs to go so we can get pricing started?',
    jitter: false,
  }).catch((error) => {
    log.warn({ err: error }, 'Failed to send Messenger address acknowledgment.');
  });
  return {
    contextState: nextState,
    stopProcessing: false,
    overrideText: `Address confirmed: ${extracted}`,
  };
}

async function maybeHandleMessengerSlotSelection({
  slotMatch,
  lead,
  psid,
  timeZone,
  log,
  quickReplyPayload,
  proposedSlots,
  conversation,
}: {
  slotMatch: ReturnType<typeof matchSlotSelection>;
  lead: LeadWithRelations;
  psid: string;
  timeZone: string;
  log: RouteLogger;
  quickReplyPayload: string | null;
  proposedSlots: ProposedSlot[];
  conversation: ConversationRecord;
}): Promise<boolean> {
  let resolvedMatch = slotMatch;
  if (!resolvedMatch && quickReplyPayload?.startsWith(SLOT_SELECT_PREFIX)) {
    const slotId = quickReplyPayload.slice(SLOT_SELECT_PREFIX.length);
    const slot = proposedSlots.find((candidate) => candidate.id === slotId);
    if (slot) {
      resolvedMatch = { slot, reason: 'label_match' };
    }
  }

  if (!resolvedMatch) {
    return false;
  }
  try {
    const result = await confirmSlotDirect({
      lead_id: lead.id,
      slot: resolvedMatch.slot,
      quote_id: lead.quotes[0]?.id,
      notes: undefined,
      address: lead.address ?? undefined,
    });

    if ('needs_address' in result) {
      await sendMessengerMessage({
        to: psid,
        text: result.message,
        jitter: false,
      });
      return true;
    }

    const eventPayload: Record<string, unknown> = {
      slot_id: resolvedMatch.slot.id,
      channel: 'messenger',
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
      log.warn({ err: error }, 'Failed to record job event after auto confirmation.');
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

    await sendMessengerMessage({
      to: psid,
      text: confirmationText,
      jitter: false,
    });

    await prisma.audit.create({
      data: {
        leadId: lead.id,
        actor: 'system',
        action: 'slot_confirmed_auto',
        payload: {
          slot_id: slotMatch.slot.id,
          channel: 'messenger',
        } as Prisma.JsonObject,
      },
    });

    return true;
  } catch (error) {
    log.error({ err: error }, 'Automatic slot confirmation failed.');
    return false;
  }
}

type MessengerContextDecision = {
  stopProcessing: boolean;
  overrideText?: string;
};

async function maybeHandleMessengerContextGating({
  lead,
  conversation,
  messageText,
  quickReplyPayload,
  psid,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  messageText: string;
  quickReplyPayload: string | null;
  psid: string;
  log: RouteLogger;
}): Promise<MessengerContextDecision> {
  if (
    !isContextMemoryEnabled() ||
    !isStrictAddressConfirmationEnabled() ||
    !lead.customerId
  ) {
    return { stopProcessing: false };
  }

  let contextState = readContextMemoryState(conversation.metadata);

  if (isAwaitingNewAddress(contextState)) {
    const addressResult = await handleMessengerAddressCapture({
      messageText,
      lead,
      psid,
      conversation,
      contextState,
      log,
    });
    contextState = addressResult.contextState;
    if (addressResult.stopProcessing) {
      return { stopProcessing: true };
    }
    return {
      stopProcessing: false,
      overrideText: addressResult.overrideText,
    };
  }

  const pendingOptions = readPendingCandidateOptions(contextState);
  const selection = parseCandidateSelectionInput({
    payload: quickReplyPayload,
    text: messageText,
    options: pendingOptions,
  });
  if (selection) {
    const selectedCandidate = selection.candidate;
    const selectionState: ContextMemoryState = {
      ...contextState,
      pending_candidate_id: selectedCandidate.id,
      pending_candidate_prompt: buildAddressConfirmPrompt(selectedCandidate),
      pending_candidate_summary: selectedCandidate.summary,
      pending_candidate_address: selectedCandidate.addressLine ?? null,
      pending_sent_at: new Date().toISOString(),
      pending_candidate_snapshot: JSON.stringify(serializeCandidate(selectedCandidate)),
      pending_candidate_options: [],
    };
    conversation.metadata = await writeContextMemoryState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState: selectionState,
    });
    contextState = selectionState;
    const updatedState = await handleContextConfirmationChoice({
      choice: 'yes',
      lead,
      candidateId: selectedCandidate.id,
      conversation,
      contextState,
      log,
    });
    contextState = updatedState;
    return { stopProcessing: false, overrideText: confirmationText('yes') };
  }

  let pendingCandidateId = getStringField(contextState, 'pending_candidate_id');
  const choice = parseContextConfirmationInput(quickReplyPayload, messageText);

  if (choice && pendingCandidateId) {
    const updatedState = await handleContextConfirmationChoice({
      choice,
      lead,
      candidateId: pendingCandidateId,
      conversation,
      contextState,
      log,
    });
    contextState = updatedState;
    if (choice === 'different') {
      contextState = await promptMessengerForAddress({
        psid,
        conversation,
        contextState,
        log,
      });
      return { stopProcessing: true };
    }
    return { stopProcessing: false, overrideText: confirmationText(choice) };
  }

  if (choice) {
    if (choice === 'different') {
      contextState = await promptMessengerForAddress({
        psid,
        conversation,
        contextState,
        log,
      });
      return { stopProcessing: true };
    }
    return { stopProcessing: false, overrideText: confirmationText(choice) };
  }

  const refreshedOptions = readPendingCandidateOptions(contextState);
  if (refreshedOptions.length > 0) {
    const { sent, prompt } = await sendMessengerCandidateOptionsPrompt({
      psid,
      options: refreshedOptions,
      log,
    });
    if (sent) {
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
      contextState = nextState;
      return { stopProcessing: true };
    }
  }

  pendingCandidateId = getStringField(contextState, 'pending_candidate_id');
  if (pendingCandidateId) {
    const prompt = getStringField(contextState, 'pending_candidate_prompt');
    if (prompt) {
      const sent = await sendMessengerContextPrompt(psid, prompt, log);
      if (!sent) {
        return { stopProcessing: false };
      }
    }
    return { stopProcessing: true };
  }

  if (!messageText || messageText === '[photos uploaded]') {
    return { stopProcessing: false };
  }

  const candidateResult = await findNextContextCandidate({
    customerId: lead.customerId,
    messageText,
    contextState,
    log,
  });

  if (candidateResult.disambiguation.length >= 2) {
    const { sent, prompt } = await sendMessengerCandidateOptionsPrompt({
      psid,
      options: candidateResult.disambiguation,
      log,
    });
    if (sent) {
      const serializedOptions = candidateResult.disambiguation.map((candidate) =>
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
        pending_candidate_options: serializedOptions,
      };
      conversation.metadata = await writeContextMemoryState({
        conversationId: conversation.id,
        existingMetadata: conversation.metadata,
        nextState,
      });
      contextState = nextState;
      await prisma.audit.create({
        data: {
          leadId: lead.id,
          actor: 'system',
          action: 'context_prompted',
          payload: {
            candidate_ids: candidateResult.disambiguation.map((candidate) => candidate.id),
            summaries: candidateResult.disambiguation.map((candidate) => candidate.summary),
            mode: 'disambiguation',
          } as Prisma.JsonObject,
        },
      });
      return { stopProcessing: true };
    }
  }

  const candidate = candidateResult.candidate;
  if (!candidate) {
    return { stopProcessing: false };
  }

  const prompt = buildAddressConfirmPrompt(candidate);
  log.info(
    {
      workflow_step: 'context_prompt_candidate',
      candidate_id: candidate.id,
      candidate_score: candidate.score,
      prompt_snippet: maskText(prompt, 'prompt'),
    },
    'Context confirmation prompt sending.',
  );
  const sent = await sendMessengerContextPrompt(psid, prompt, log);
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

async function handleContextConfirmationChoice({
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
  log: RouteLogger;
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
  const awaitingNewAddress = choice === 'different';
  const nextState: ContextMemoryState = {
    ...baseState,
    dismissed_candidate_ids: Array.from(dismissed),
    latest_context_job_id: getStringField(contextState, 'latest_context_job_id'),
    awaiting_new_address: awaitingNewAddress,
    awaiting_address_attempts: awaitingNewAddress
      ? getAddressPromptAttempts(contextState)
      : 0,
    awaiting_address_prompted_at: awaitingNewAddress
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

async function findNextContextCandidate({
  customerId,
  messageText,
  contextState,
  log,
}: {
  customerId: string;
  messageText: string;
  contextState: ContextMemoryState;
  log: RouteLogger;
}): Promise<CandidateSearchResult> {
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
    log.warn({ err: error }, 'Failed to fetch context candidates.');
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
  return CONFIRMATION_TEXT_MAP[choice];
}

function getContextBasis(contextState: ContextMemoryState): string | undefined {
  const confirmed = getStringArrayField(contextState, 'confirmed_candidate_ids');
  if (confirmed.length > 0) {
    return 'prior_job_context_confirmed';
  }
  return undefined;
}

async function sendMessengerContextPrompt(
  psid: string,
  text: string,
  log: RouteLogger,
): Promise<boolean> {
  try {
    await sendMessengerMessage({
      to: psid,
      text,
      quickReplies: ADDRESS_CONFIRMATION_REPLIES,
      jitter: false,
    });
    return true;
  } catch (error) {
    log.error({ err: error }, 'Failed to send Messenger context prompt.');
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
  log: RouteLogger;
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

type MessengerSchedulingDecision = {
  stopProcessing: boolean;
  overrideText?: string;
};

async function maybeHandleMessengerScheduling({
  lead,
  conversation,
  messageText,
  quickReplyPayload,
  psid,
  timeZone,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  messageText: string;
  quickReplyPayload: string | null;
  psid: string;
  timeZone: string;
  log: RouteLogger;
}): Promise<MessengerSchedulingDecision> {
  const schedulingState = readSchedulingState(conversation.metadata);
  const pendingConfirmation = schedulingState.pending_confirmation ?? null;
  const confirmationFromPayload = parseSchedulingConfirmationPayload(quickReplyPayload);
  if (confirmationFromPayload && pendingConfirmation) {
    return handleSchedulingConfirmationChoice({
      choice: confirmationFromPayload.choice,
      lead,
      conversation,
      schedulingState,
      pendingConfirmation,
      psid,
      timeZone,
      log,
    });
  }

  if (pendingConfirmation) {
    const textChoice = parseContextConfirmationInput(null, messageText);
    if (textChoice) {
      return handleSchedulingConfirmationChoice({
        choice: textChoice,
        lead,
        conversation,
        schedulingState,
        pendingConfirmation,
        psid,
        timeZone,
        log,
      });
    }
  }

  const schedulingIntent = detectSchedulingIntent(
    textPayload ? expandTimeShorthand(textPayload) : messageText,
    timeZone,
  );
  if (!schedulingIntent) {
    return { stopProcessing: false };
  }

  const prompt = `Want us to line up pickup windows for ${schedulingIntent.label}?`;
  await sendMessengerMessage({
    to: psid,
    text: prompt,
    quickReplies: [
      { title: 'Yes', payload: `${SCHED_CONFIRM_YES}|${schedulingIntent.iso}` },
      { title: 'No', payload: `${SCHED_CONFIRM_NO}|${schedulingIntent.iso}` },
      { title: 'Different day', payload: `${SCHED_CONFIRM_DIFFERENT}|${schedulingIntent.iso}` },
    ],
    jitter: false,
  });

  const nextState: SchedulingState = {
    ...schedulingState,
    pending_confirmation: {
      iso: schedulingIntent.iso,
      label: schedulingIntent.label,
      prompt,
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

type SchedulingConfirmationChoice = 'yes' | 'no' | 'different';

async function handleSchedulingConfirmationChoice({
  choice,
  lead,
  conversation,
  schedulingState,
  pendingConfirmation,
  psid,
  timeZone,
  log,
}: {
  choice: SchedulingConfirmationChoice;
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  schedulingState: SchedulingState;
  pendingConfirmation: NonNullable<SchedulingState['pending_confirmation']>;
  psid: string;
  timeZone: string;
  log: RouteLogger;
}): Promise<MessengerSchedulingDecision> {
  const baseState: SchedulingState = {
    ...schedulingState,
    pending_confirmation: null,
  };
  if (choice === 'yes') {
    const handled = await sendMessengerSlotsForDate({
      lead,
      conversation,
      iso: pendingConfirmation.iso,
      preferredText: pendingConfirmation.preferred_text ?? null,
      psid,
      timeZone,
      schedulingState: baseState,
      log,
    });
    return { stopProcessing: handled };
  }

  if (choice === 'different') {
    await sendMessengerMessage({
      to: psid,
      text: 'No problem—what day and time should we aim for?',
      jitter: false,
    });
    conversation.metadata = await writeSchedulingState({
      conversationId: conversation.id,
      existingMetadata: conversation.metadata,
      nextState: baseState,
    });
    return { stopProcessing: true };
  }

  await sendMessengerMessage({
    to: psid,
    text: 'Okay! Just share the day and time you prefer, and we’ll check availability.',
    jitter: false,
  });
  conversation.metadata = await writeSchedulingState({
    conversationId: conversation.id,
    existingMetadata: conversation.metadata,
    nextState: baseState,
  });
  return { stopProcessing: true };
}

async function sendMessengerSlotsForDate({
  lead,
  conversation,
  iso,
  preferredText,
  psid,
  timeZone,
  schedulingState,
  log,
}: {
  lead: LeadWithRelations;
  conversation: ConversationRecord;
  iso: string;
  preferredText: string | null;
  psid: string;
  timeZone: string;
  schedulingState: SchedulingState;
  log: RouteLogger;
}): Promise<boolean> {
  try {
    const result = await proposeSlotsDirect({
      lead_id: lead.id,
      preferred_day: iso,
      preferred_time_text: preferredText ?? undefined,
    });
    let slots = result.slots;
    let header = `Here’s what’s open around ${formatScheduleLabel(new Date(iso), timeZone)}:`;

    if (!slots.length) {
      const fallback = await proposeSlotsDirect({
        lead_id: lead.id,
        preferred_day: undefined,
        preferred_time_text: undefined,
      });
      if (!fallback.slots.length) {
        await sendMessengerMessage({
          to: psid,
          text: 'I couldn’t find openings near that time. Want to try a different day?',
          jitter: false,
        });
        conversation.metadata = await writeSchedulingState({
          conversationId: conversation.id,
          existingMetadata: conversation.metadata,
          nextState: schedulingState,
        });
        return true;
      }
      slots = fallback.slots;
      header = 'Nothing open at that time, but the soonest windows are:';
    }

    const quickReplies = slots.slice(0, 3).map((slot) => ({
      title: formatSlotQuickReplyTitle(slot, timeZone),
      payload: `${SLOT_SELECT_PREFIX}${slot.id}`,
    }));
    const lines = slots.slice(0, 3).map((slot, index) => {
      const label = formatSlotLabel(slot);
      return `${index + 1}. ${label}`;
    });
    const text = [header].concat(lines).join('\n');

    await sendMessengerMessage({
      to: psid,
      text,
      quickReplies,
      jitter: false,
    });

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
    log.warn({ err: error }, 'Failed to propose slots automatically.');
    return false;
  }
}

function parseSchedulingConfirmationPayload(
  payload: string | null,
): { choice: SchedulingConfirmationChoice; iso?: string } | null {
  if (!payload) {
    return null;
  }
  if (!payload.startsWith('SCHED_CONFIRM_')) {
    return null;
  }
  const [prefix, iso] = payload.split('|');
  if (prefix === SCHED_CONFIRM_YES) {
    return { choice: 'yes', iso };
  }
  if (prefix === SCHED_CONFIRM_NO) {
    return { choice: 'no', iso };
  }
  if (prefix === SCHED_CONFIRM_DIFFERENT) {
    return { choice: 'different', iso };
  }
  return null;
}

function detectSchedulingIntent(
  text: string | null,
  timeZone: string,
): { iso: string; label: string; preferredText: string } | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeForIntent(text);
  const keywordHit = SCHEDULING_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
  if (!keywordHit) {
    return null;
  }
  const resolved = resolvePreferredDateTime(expandTimeShorthand(text), timeZone);
  if (!resolved) {
    return null;
  }
  const iso = resolved.toISOString();
  const label = formatScheduleLabel(resolved, timeZone);
  return { iso, label, preferredText: text };
}

function formatScheduleLabel(date: Date, timeZone: string): string {
  const dt = DateTime.fromJSDate(date, { zone: timeZone });
  return dt.toFormat('ccc MMM d h:mm a');
}

function formatSlotQuickReplyTitle(slot: ProposedSlot, timeZone: string): string {
  const start = DateTime.fromISO(slot.window_start).setZone(timeZone);
  const end = DateTime.fromISO(slot.window_end).setZone(timeZone);
  return `${start.toFormat('ccc h a')}-${end.toFormat('h a')}`.slice(0, 20);
}

function truncateMessage(text: string, max = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function formatSlotLabel(slot: ProposedSlot): string {
  const start = DateTime.fromISO(slot.window_start, { zone: 'utc' }).setZone(
    'America/New_York',
  );
  const end = DateTime.fromISO(slot.window_end, { zone: 'utc' }).setZone(
    'America/New_York',
  );
  if (!start.isValid || !end.isValid) {
    return slot.label ?? slot.id;
  }
  return `${start.toFormat('ccc LLL d h:mm a')}–${end.toFormat('h:mm a')}`;
}

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
  const requestLog = wrapFastifyLogger(request.log).child({
    channel: 'messenger',
    requestId: request.id,
  });

  for (const event of events) {
    // Fire and forget with error logging.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    processMessengerEvent(event, { log: requestLog, requestId: request.id }).catch((error) => {
      requestLog.error({ err: error }, 'Messenger event processing failed');
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
