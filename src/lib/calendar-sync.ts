import { differenceInMinutes, subDays } from 'date-fns';
import { Prisma } from '@prisma/client';

import {
  calendarFeatureEnabled,
  getCalendarConfig,
  getAccessToken,
} from './google-calendar.ts';
import { prisma } from './prisma.ts';

type GoogleEvent = {
  id: string;
  status: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  iCalUID?: string;
  etag?: string;
  extendedProperties?: { private?: Record<string, string> };
};

const SYNC_INTERVAL_MS = Number(
  process.env.GOOGLE_CALENDAR_SYNC_INTERVAL_MS ?? 5 * 60 * 1000,
);

async function fetchCalendarPage({
  calendarId,
  timeZone,
  syncToken,
  pageToken,
}: {
  calendarId: string;
  timeZone: string;
  syncToken?: string | null;
  pageToken?: string;
}) {
  const token = await getAccessToken();
  const base = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  base.searchParams.set('showDeleted', 'true');
  base.searchParams.set('singleEvents', 'true');
  base.searchParams.set('maxResults', '250');
  if (pageToken) base.searchParams.set('pageToken', pageToken);
  if (syncToken) {
    base.searchParams.set('syncToken', syncToken);
  } else {
    const since = subDays(new Date(), 14).toISOString();
    base.searchParams.set('timeMin', since);
    base.searchParams.set('orderBy', 'startTime');
    base.searchParams.set('timeZone', timeZone);
  }

  const res = await fetch(base.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 410) {
    // syncToken expired
    const error: Error & { code?: string } = new Error('Sync token expired');
    error.code = 'sync_token_expired';
    throw error;
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Google events.list failed: ${res.status} ${res.statusText} ${detail}`,
    );
  }

  const body = (await res.json()) as {
    items?: GoogleEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };

  return body;
}

function parseEventDate(event: GoogleEvent, field: 'start' | 'end'): Date | null {
  const part = field === 'start' ? event.start : event.end;
  if (!part) return null;
  const iso = part.dateTime ?? part.date;
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

async function handleEvent(event: GoogleEvent) {
  const jobId = event.extendedProperties?.private?.jobId;
  if (!jobId) {
    return;
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }

  if (event.status === 'cancelled') {
    if (job.status !== 'cancelled') {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'cancelled',
          googleEventEtag: event.etag ?? job.googleEventEtag,
        },
      });
      await prisma.audit.create({
        data: {
          leadId: job.leadId,
          actor: 'system',
          action: 'calendar_event_cancelled',
          payload: {
            job_id: job.id,
            event_id: event.id,
          } as Prisma.JsonObject,
        },
      });
    }
    return;
  }

  const start = parseEventDate(event, 'start');
  const end = parseEventDate(event, 'end');
  if (!start) {
    return;
  }
  const safeEnd = end ?? new Date(start.getTime() + 90 * 60 * 1000);
  if (differenceInMinutes(safeEnd, start) <= 0) {
    return;
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      windowStart: start,
      windowEnd: safeEnd,
      googleCalendarId: job.googleCalendarId ?? event.extendedProperties?.private?.calendarId,
      googleEventId: event.id,
      googleEventICalUid: event.iCalUID ?? job.googleEventICalUid,
      googleEventEtag: event.etag,
      googleEventHtmlLink: event.htmlLink ?? job.googleEventHtmlLink,
    },
  });

  await prisma.audit.create({
    data: {
      leadId: job.leadId,
      actor: 'system',
      action: 'calendar_event_synced',
      payload: {
        job_id: job.id,
        event_id: event.id,
      } as Prisma.JsonObject,
    },
  });
}

async function processCalendarChanges() {
  if (!calendarFeatureEnabled()) {
    return;
  }
  const cfg = getCalendarConfig();
  if (!cfg) {
    return;
  }

  const state = await prisma.calendarSyncState.findUnique({
    where: { calendarId: cfg.id },
  });

  let syncToken = state?.syncToken ?? null;
  let pageToken: string | undefined;

  try {
    do {
      const page = await fetchCalendarPage({
        calendarId: cfg.id,
        timeZone: cfg.timeZone,
        syncToken,
        pageToken,
      });

      for (const event of page.items ?? []) {
        // eslint-disable-next-line no-await-in-loop
        await handleEvent(event);
      }

      pageToken = page.nextPageToken;
      if (!pageToken && page.nextSyncToken) {
        syncToken = page.nextSyncToken;
      }
    } while (pageToken);
  } catch (error) {
    if ((error as Error & { code?: string }).code === 'sync_token_expired') {
      await prisma.calendarSyncState.upsert({
        where: { calendarId: cfg.id },
        create: { calendarId: cfg.id, syncToken: null },
        update: { syncToken: null },
      });
      // Retry once with fresh window
      return processCalendarChanges();
    }
    console.error('Calendar sync failed', error);
    return;
  }

  if (syncToken) {
    await prisma.calendarSyncState.upsert({
      where: { calendarId: cfg.id },
      create: { calendarId: cfg.id, syncToken },
      update: { syncToken },
    });
  }
}

let intervalHandle: NodeJS.Timeout | null = null;

export async function startCalendarSync(): Promise<void> {
  if (!calendarFeatureEnabled()) {
    console.info('[CalendarSync] Disabled via feature flag.');
    return;
  }
  await processCalendarChanges();
  intervalHandle = setInterval(() => {
    void processCalendarChanges();
  }, SYNC_INTERVAL_MS);
  console.info('[CalendarSync] Started polling every', SYNC_INTERVAL_MS / 1000, 'seconds.');
}

export function stopCalendarSync(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
