import nodemailer, { type Transporter } from 'nodemailer';
import process from 'node:process';
import { getLogger, maskEmail, maskText } from './log.ts';

type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  bcc?: string;
};

type EmailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  bcc?: string;
};

let cachedConfig: EmailConfig | null | undefined;
let transporterPromise: Promise<Transporter> | null = null;
const log = getLogger().child({ module: 'email' });

const getEmailConfig = (): EmailConfig | null => {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const host = process.env.SMTP_HOST;
  const port = Number.parseInt(process.env.SMTP_PORT ?? '', 10);
  const username = process.env.SMTP_USERNAME;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.EMAIL_FROM;
  const bcc = process.env.EMAIL_BCC;

  if (!host || Number.isNaN(port) || !username || !password || !from) {
    log.warn(
      {
        host_present: Boolean(host),
        port_present: !Number.isNaN(port),
        username_present: Boolean(username),
        from_present: Boolean(from),
      },
      'Email credentials missing; transactional emails will be skipped.',
    );
    cachedConfig = null;
    return cachedConfig;
  }

  const secureEnv = (process.env.SMTP_SECURE ?? 'true').toLowerCase();
  const secure = secureEnv === 'true' || secureEnv === '1';

  cachedConfig = {
    host,
    port,
    secure,
    username,
    password,
    from,
    bcc,
  };

  return cachedConfig;
};

const getTransporter = async (): Promise<Transporter> => {
  if (!transporterPromise) {
    const config = getEmailConfig();
    if (!config) {
      throw new Error('Email configuration not available.');
    }
    transporterPromise = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.username,
        pass: config.password,
      },
    });
  }
  return transporterPromise;
};

export async function sendTransactionalEmail(
  payload: EmailPayload,
): Promise<void> {
  const config = getEmailConfig();
  if (!config) {
    log.info(
      {
        reason: 'missing_credentials',
        to: maskEmail(payload.to),
        subject: maskText(payload.subject, 'subject'),
      },
      'Transactional email send skipped.',
    );
    return;
  }

  const childLog = log.child({
    to: maskEmail(payload.to),
  });

  try {
    const transporter = await getTransporter();
    await transporter.sendMail({
      from: config.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      bcc: payload.bcc ?? config.bcc,
      });
    childLog.info(
      {
        subject: maskText(payload.subject, 'subject'),
        has_html: Boolean(payload.html),
      },
      'Transactional email sent.',
    );
  } catch (error) {
    childLog.error(
      {
        err: error,
        subject: maskText(payload.subject, 'subject'),
      },
      'Failed to send transactional email.',
    );
    throw error;
  }
}
