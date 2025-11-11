import Twilio from 'twilio';
import { getLogger, maskPhone } from '../lib/log.ts';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

const baseLog = getLogger().child({ module: 'twilio_adapter', channel: 'sms' });

if ((accountSid || authToken || fromNumber) && (!accountSid || !authToken || !fromNumber)) {
  baseLog.warn(
    {
      accountSid: accountSid ? '[present]' : '[missing]',
      authToken: authToken ? '[present]' : '[missing]',
      fromConfigured: Boolean(fromNumber),
    },
    'Twilio env variables partially set.',
  );
}

const twilioClient =
  accountSid && authToken ? Twilio(accountSid, authToken) : undefined;

export async function sendSmsMessage(to: string, body: string): Promise<void> {
  if (!twilioClient || !fromNumber) {
    throw new Error('Twilio client not configured.');
  }

  const childLog = baseLog.child({
    to_fingerprint: maskPhone(to) ?? '[redacted:phone]',
    from_fingerprint: maskPhone(fromNumber) ?? '[redacted:phone]',
  });
  const sendStart = Date.now();

  try {
    const message = await twilioClient.messages.create({
      body,
      from: fromNumber,
      to,
    });
    childLog.info(
      {
        body_length: body.length,
        sid: message.sid,
        status: message.status,
        duration_ms: Date.now() - sendStart,
      },
      'Twilio SMS sent.',
    );
  } catch (error) {
    childLog.error(
      {
        err: error,
        body_length: body.length,
        duration_ms: Date.now() - sendStart,
      },
      'Twilio SMS send failed.',
    );
    throw error;
  }
}

export function validateTwilioSignature({
  url,
  params,
  signature,
}: {
  url: string;
  params: Record<string, unknown>;
  signature: string | undefined;
}): boolean {
  if (!authToken) {
    return true;
  }
  if (!signature) {
    return false;
  }
  return Twilio.validateRequest(authToken, signature, url, params);
}
