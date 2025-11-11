import { isAfter } from 'date-fns';

import { sendMessengerMessage } from '../adapters/messenger.js';
import { generateReminderEmail } from './email-content.js';
import { sendTransactionalEmail } from './email.js';
import { prisma } from './prisma.js';
import { getCalendarConfig } from './google-calendar.js';
import { DateTime } from 'luxon';
import { getLogger, maskEmail } from './log.ts';

const POLL_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
const log = getLogger().child({ module: 'reminder_scheduler' });

async function dispatchReminder(jobId: string) {
  const start = Date.now();
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { lead: true },
  });
  if (!job || !job.lead?.messengerPsid) {
    log.warn(
      {
        jobId,
        hasLead: Boolean(job?.lead),
      },
      'Reminder dispatch skipped; missing job or messengerPsid.',
    );
    return;
  }
  const dispatchLog = log.child({
    jobId: job.id,
    leadId: job.lead.id,
  });
  const cfg = getCalendarConfig();
  const tz = cfg?.timeZone ?? 'America/New_York';
  const startLocal = DateTime.fromJSDate(job.windowStart).setZone(tz);
  const endLocal = DateTime.fromJSDate(job.windowEnd).setZone(tz);
  const startStr = startLocal.toFormat('h:mm a');
  const endStr = endLocal.toFormat('h:mm a');

  dispatchLog.info(
    {
      window_start: job.windowStart.toISOString(),
      window_end: job.windowEnd.toISOString(),
    },
    'Dispatching reminder.',
  );

  await sendMessengerMessage({
    to: job.lead.messengerPsid,
    text: `Hi there! Reminder that we are scheduled for pickup between ${startStr} and ${endStr} tomorrow. Reply if anything changes.`,
    jitter: false,
  }).catch((error) => {
    dispatchLog.error(
      {
        err: error,
      },
      'Failed to send reminder via Messenger.',
    );
    throw error;
  });

  if (job.lead.email) {
    try {
      const companyName = process.env.COMPANY_NAME ?? 'Junk Wizards';
      const email = await generateReminderEmail({
        leadName: job.lead.name ?? undefined,
        companyName,
        address: job.lead.address ?? undefined,
        windowStart: job.windowStart,
        windowEnd: job.windowEnd,
        reminderPhone: process.env.SUPPORT_PHONE ?? job.lead.phone ?? undefined,
      });

      await sendTransactionalEmail({
        to: job.lead.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      await prisma.audit.create({
        data: {
          leadId: job.lead.id,
          actor: 'system',
          action: 'reminder_email_sent',
          payload: { job_id: job.id },
        },
      });
      dispatchLog.info(
        {
          email: maskEmail(job.lead.email),
        },
        'Reminder email sent.',
      );
    } catch (error) {
      dispatchLog.warn(
        {
          err: error,
          email: maskEmail(job.lead.email),
          retryable: true,
        },
        'Failed to send reminder email; audit recorded.',
      );
      await prisma.audit.create({
        data: {
          leadId: job.lead.id,
          actor: 'system',
          action: 'reminder_email_failed',
          payload: {
            job_id: job.id,
            error: error instanceof Error ? error.message : 'unknown error',
          },
        },
      });
    }
  } else {
    dispatchLog.info(
      {
        email: null,
        reason: 'no_email',
      },
      'Reminder email skipped.',
    );
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      reminderSentAt: new Date(),
    },
  });

  await prisma.lead.update({
    where: { id: job.lead.id },
    data: { stage: 'reminding' },
  });

  await prisma.audit.create({
    data: {
      leadId: job.lead.id,
      actor: 'system',
      action: 'reminder_sent',
      payload: { job_id: job.id },
    },
  });

  dispatchLog.info(
    {
      window_start: job.windowStart.toISOString(),
      window_end: job.windowEnd.toISOString(),
      duration_ms: Date.now() - start,
    },
    'Reminder dispatch completed.',
  );
}

async function pollForReminders() {
  const now = new Date();
  const start = Date.now();
  log.info({ timestamp: now.toISOString() }, 'Reminder poll started.');
  const upcoming = await prisma.job.findMany({
    where: {
      reminderScheduledAt: { lte: now },
      reminderSentAt: null,
      status: 'booked',
    },
    select: { id: true, reminderScheduledAt: true },
  });
  let dispatchedCount = 0;
  for (const job of upcoming) {
    if (job.reminderScheduledAt && !isAfter(job.reminderScheduledAt, now)) {
      await dispatchReminder(job.id);
      dispatchedCount += 1;
    }
  }
  log.info(
    {
      upcoming_count: upcoming.length,
      dispatched_count: dispatchedCount,
      duration_ms: Date.now() - start,
    },
    'Reminder poll completed.',
  );
}

export function startReminderScheduler(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    pollForReminders().catch((error) => {
      log.error(
        {
          err: error,
          retryable: true,
        },
        'Reminder scheduler error.',
      );
    });
  }, POLL_INTERVAL_MS);
  log.info({ poll_interval_ms: POLL_INTERVAL_MS }, 'Reminder scheduler started.');
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
