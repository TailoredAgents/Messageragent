import { formatInTimeZone } from 'date-fns-tz';
import { DateTime } from 'luxon';

export function makeZonedDate(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
): Date {
  const dt = DateTime.fromObject(
    { year: y, month: m, day: d, hour: h, minute: min, second: 0 },
    { zone: timeZone },
  );
  if (!dt.isValid) {
    throw new Error(`Failed to build zoned date for ${timeZone}: ${dt.invalidReason ?? 'invalid'}`);
  }
  return dt.toUTC().toJSDate();
}

export function formatLocalRange(
  timeZone: string,
  start: Date,
  end: Date,
): string {
  const day = formatInTimeZone(start, timeZone, 'EEE MMM d');
  const s = formatInTimeZone(start, timeZone, 'h:mm a');
  const e = formatInTimeZone(end, timeZone, 'h:mm a');
  return `${day} ${s}–${e}`;
}

export function getLocalYMD(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const dt = DateTime.fromJSDate(date, { zone: timeZone });
  return { y: dt.year, m: dt.month, d: dt.day };
}
