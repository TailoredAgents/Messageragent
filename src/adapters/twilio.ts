import Twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if ((accountSid || authToken || fromNumber) && (!accountSid || !authToken || !fromNumber)) {
  console.warn(
    'Twilio environment variables are partially set. Ensure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are all defined.',
  );
}

const twilioClient =
  accountSid && authToken ? Twilio(accountSid, authToken) : undefined;

export async function sendSmsMessage(to: string, body: string): Promise<void> {
  if (!twilioClient || !fromNumber) {
    throw new Error('Twilio client not configured.');
  }

  await twilioClient.messages.create({
    body,
    from: fromNumber,
    to,
  });
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
