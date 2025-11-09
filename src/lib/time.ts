import { formatInTimeZone } from 'date-fns-tz';

export function makeZonedDate(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
): Date {
  // months are 1-based in our inputs; JS Date expects 0-based
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00 ${timeZone}`;
  // date-fns-tz zonedTimeToUtc is unavailable in this version, so rely on Date parsing.
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Failed to parse date for zone ${timeZone}: ${iso}`);
  }
  return parsed;
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
  const y = Number(formatInTimeZone(date, timeZone, 'yyyy'));
  const m = Number(formatInTimeZone(date, timeZone, 'MM'));
  const d = Number(formatInTimeZone(date, timeZone, 'dd'));
  return { y, m, d };
}
