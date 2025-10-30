import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

type CalendarInput = {
  jobId: string;
  leadName?: string | null;
  address: string;
  windowStart: Date;
  windowEnd: Date;
  baseUrl?: string;
};

const CALENDAR_DIR = path.join(process.cwd(), 'storage', 'calendar');

export async function createCalendarHold({
  jobId,
  leadName,
  address,
  windowStart,
  windowEnd,
  baseUrl,
}: CalendarInput): Promise<{ url?: string; filePath: string }> {
  await mkdir(CALENDAR_DIR, { recursive: true });

  const summary = leadName
    ? `Junk pickup for ${leadName}`
    : 'Junk pickup';

  const formatDate = (date: Date) => {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };

  const content = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JunkQuoteAgent//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${jobId}@junkquote.local`,
    `DTSTAMP:${formatDate(new Date())}`,
    `DTSTART:${formatDate(windowStart)}`,
    `DTEND:${formatDate(windowEnd)}`,
    `SUMMARY:${summary}`,
    `LOCATION:${address}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  const fileName = `${jobId}.ics`;
  const filePath = path.join(CALENDAR_DIR, fileName);
  await writeFile(filePath, content, 'utf8');

  const url =
    baseUrl != null
      ? `${baseUrl.replace(/\/$/, '')}/calendar/${fileName}`
      : undefined;

  return { url, filePath };
}

