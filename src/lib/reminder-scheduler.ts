import { isAfter } from 'date-fns';

import { sendMessengerMessage } from '../adapters/messenger.js';
import { generateReminderEmail } from './email-content.js';
import { sendTransactionalEmail } from './email.js';
import { prisma } from './prisma.js';
import { getCalendarConfig } from './google-calendar.js';
import { DateTime } from 'luxon';

const POLL_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

async function dispatchReminder(jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { lead: true },
  });
  if (!job || !job.lead?.messengerPsid) {
    return;
  }

  const cfg = getCalendarConfig();
  const tz = cfg?.timeZone ?? 'America/New_York';
  const startLocal = DateTime.fromJSDate(job.windowStart).setZone(tz);
  const endLocal = DateTime.fromJSDate(job.windowEnd).setZone(tz);
  const startStr = startLocal.toFormat('h:mm a');
  const endStr = endLocal.toFormat('h:mm a');

  await sendMessengerMessage({
    to: job.lead.messengerPsid,
    text: `Hi there! Reminder that we are scheduled for pickup between ${startStr} and ${endStr} tomorrow. Reply if anything changes.`,
    jitter: false,
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
    } catch (error) {
      console.error('Failed to send reminder email', error);
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
}

async function pollForReminders() {
  const now = new Date();
  const upcoming = await prisma.job.findMany({
    where: {
      reminderScheduledAt: { lte: now },
      reminderSentAt: null,
      status: 'booked',
    },
    select: { id: true, reminderScheduledAt: true },
  });

  for (const job of upcoming) {
    if (job.reminderScheduledAt && !isAfter(job.reminderScheduledAt, now)) {
      await dispatchReminder(job.id);
    }
  }
}

export function startReminderScheduler(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    pollForReminders().catch((error) => {
      console.error('Reminder scheduler error', error);
    });
  }, POLL_INTERVAL_MS);
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
