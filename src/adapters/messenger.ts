import { createHash } from 'node:crypto';
import { getLogger, maskText, type LoggerInstance } from '../lib/log.ts';

const GRAPH_API_VERSION = process.env.FB_GRAPH_VERSION ?? 'v17.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

let tokenFingerprintLogged = false;
const baseLog = getLogger().child({ module: 'messenger_adapter' });

function fingerprintToken(token: string | undefined): string {
  if (!token) {
    return '[missing]';
  }
  const hash = createHash('sha256').update(token).digest('hex');
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function fingerprintRecipient(id: string): string {
  const hash = createHash('sha256').update(id).digest('hex');
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export type MessengerSendOptions = {
  to: string;
  text?: string;
  quickReplies?: Array<{ title: string; payload: string }>;
  attachments?: Array<{ type: 'image' | 'file'; url: string }>;
  // When true, delay the send by a human-like jitter.
  // Useful to simulate a person typing before replying.
  jitter?: boolean;
};

function typingIndicatorsEnabled(): boolean {
  const pref = String(process.env.MESSENGER_TYPING_ENABLED ?? 'true')
    .toLowerCase()
    .trim();
  return !['0', 'false', 'no', 'off'].includes(pref);
}

async function sendSenderAction({
  action,
  recipientId,
  accessToken,
  pageId,
  log,
}: {
  action: 'typing_on' | 'typing_off';
  recipientId: string;
  accessToken: string;
  pageId: string;
  log: LoggerInstance;
}): Promise<void> {
  const endpoint = `${GRAPH_BASE_URL}/${pageId}/messages?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      sender_action: action,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    log.warn(
      {
        status: response.status,
        statusText: response.statusText,
        detail: maskText(detail, 'sender_action_error'),
      },
      'Messenger typing indicator failed',
    );
  }
}

export async function sendMessengerMessage(
  options: MessengerSendOptions,
): Promise<void> {
  const childLog = baseLog.child({
    channel: 'messenger',
    to_fingerprint: fingerprintRecipient(options.to),
    quick_replies_count: options.quickReplies?.length ?? 0,
    attachments_count: options.attachments?.length ?? 0,
  });

  const enableSends = String(process.env.ENABLE_MESSENGER_SEND ?? 'true')
    .toLowerCase()
    .trim();
  if (['0', 'false', 'no', 'off'].includes(enableSends)) {
    childLog.info(
      {
        reason: 'disabled_env',
        text_snippet: options.text ? maskText(options.text, 'text') : undefined,
        attachments_count: options.attachments?.length ?? 0,
      },
      'Messenger send skipped.',
    );
    return;
  }

  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;

  if (!accessToken || !pageId) {
    childLog.warn(
      {
        reason: 'missing_credentials',
        text_snippet: options.text ? maskText(options.text, 'text') : undefined,
        attachments_count: options.attachments?.length ?? 0,
      },
      'Messenger send skipped.',
    );
    return;
  }

  if (!tokenFingerprintLogged) {
    tokenFingerprintLogged = true;
    childLog.info(
      {
        pageId,
        token_hash: fingerprintToken(accessToken),
      },
      'Messenger credentials loaded.',
    );
  }

  const wantJitter = options.jitter ?? true;
  const typingEnabled = typingIndicatorsEnabled();
  const typingStatus = typingEnabled && wantJitter ? 'attempted' : 'skipped';

  if (typingEnabled && wantJitter) {
    try {
      await sendSenderAction({
        action: 'typing_on',
        recipientId: options.to,
        accessToken,
        pageId,
        log: childLog,
      });
    } catch (error) {
      childLog.warn({ err: error }, 'Messenger typing_on failed');
    }
  }

  // Optional human-like delay
  if (wantJitter) {
    const minS = Number.parseInt(process.env.MESSENGER_JITTER_MIN_S ?? '5', 10);
    const maxS = Number.parseInt(process.env.MESSENGER_JITTER_MAX_S ?? '20', 10);
    if (!Number.isNaN(minS) && !Number.isNaN(maxS) && maxS >= minS && minS >= 0) {
      const ms = Math.floor((minS + Math.random() * (maxS - minS)) * 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  const endpoint = `${GRAPH_BASE_URL}/${pageId}/messages?access_token=${encodeURIComponent(accessToken)}`;

  const body: Record<string, unknown> = {
    messaging_type: 'RESPONSE',
    recipient: { id: options.to },
  };

  const message: Record<string, unknown> = {};

  if (options.text) {
    message.text = options.text;
  }

  if (options.quickReplies && options.quickReplies.length > 0) {
    message.quick_replies = options.quickReplies.map((reply) => ({
      content_type: 'text',
      title: reply.title,
      payload: reply.payload,
    }));
  }

  if (options.attachments && options.attachments.length > 0) {
    message.attachment = {
      type: options.attachments[0].type,
      payload: {
        url: options.attachments[0].url,
        is_reusable: false,
      },
    };
  }

  body.message = message;
  const sendStart = Date.now();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    childLog.error(
      {
        status: response.status,
        statusText: response.statusText,
        duration_ms: Date.now() - sendStart,
        typing_indicator: typingStatus,
        detail: maskText(detail, 'messenger_error'),
        attachments_count: options.attachments?.length ?? 0,
      },
      'Messenger send failed.',
    );
    throw new Error(
      `Failed to send Messenger message: ${response.status} ${response.statusText}`,
    );
  }

  if (typingEnabled && wantJitter) {
    void sendSenderAction({
      action: 'typing_off',
      recipientId: options.to,
      accessToken,
      pageId,
      log: childLog,
    }).catch((error) => {
      childLog.warn({ err: error }, 'Messenger typing_off failed');
    });
  }

  childLog.info(
    {
      duration_ms: Date.now() - sendStart,
      typing_indicator: typingStatus,
      text_snippet: options.text ? maskText(options.text, 'text') : undefined,
      attachments_count: options.attachments?.length ?? 0,
      attachment_type: options.attachments?.[0]?.type,
    },
    'Messenger send ok.',
  );
}
