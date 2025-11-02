const GRAPH_API_VERSION = process.env.FB_GRAPH_VERSION ?? 'v17.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MessengerSendOptions = {
  to: string;
  text?: string;
  quickReplies?: Array<{ title: string; payload: string }>;
  attachments?: Array<{ type: 'image' | 'file'; url: string }>;
  // When true, delay the send by a human-like jitter.
  // Useful to simulate a person typing before replying.
  jitter?: boolean;
};

export async function sendMessengerMessage(
  options: MessengerSendOptions,
): Promise<void> {
  const enableSends = String(process.env.ENABLE_MESSENGER_SEND ?? 'true')
    .toLowerCase()
    .trim();
  if (['0', 'false', 'no', 'off'].includes(enableSends)) {
    console.info('Messenger send disabled via ENABLE_MESSENGER_SEND; message logged instead.');
    console.info(options);
    return;
  }

  // Optional human-like delay
  const wantJitter = options.jitter ?? true;
  if (wantJitter) {
    const minS = Number.parseInt(process.env.MESSENGER_JITTER_MIN_S ?? '15', 10);
    const maxS = Number.parseInt(process.env.MESSENGER_JITTER_MAX_S ?? '45', 10);
    if (!Number.isNaN(minS) && !Number.isNaN(maxS) && maxS >= minS && minS >= 0) {
      const ms = Math.floor((minS + Math.random() * (maxS - minS)) * 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;

  if (!accessToken || !pageId) {
    console.warn('Messenger credentials missing; message logged instead.');
    console.info(options);
    return;
  }

  const endpoint = `${GRAPH_BASE_URL}/${pageId}/messages`;

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

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Failed to send Messenger message: ${response.status} ${response.statusText} ${detail}`,
    );
  }
}
