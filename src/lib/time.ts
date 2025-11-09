import { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } from 'date-fns-tz';

export function makeZonedDate(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
): Date {
  // months are 1-based in our inputs; JS Date expects 0-based
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
  return zonedTimeToUtc(iso, timeZone);
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
  const z = utcToZonedTime(date, timeZone);
  const y = Number(formatInTimeZone(z, timeZone, 'yyyy'));
  const m = Number(formatInTimeZone(z, timeZone, 'MM'));
  const d = Number(formatInTimeZone(z, timeZone, 'dd'));
  return { y, m, d };
}

