import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

export function resolvePreferredDateTime(
  phrase: string,
  timeZone: string,
  now: Date = new Date(),
): Date | null {
  const trimmed = phrase.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const reference = DateTime.fromJSDate(now).setZone(timeZone).toJSDate();
    const parsed = chrono.parse(trimmed, reference, {
      forwardDate: true,
      timezones: [timeZone],
    });
    if (!parsed || parsed.length === 0) {
      return null;
    }
    const result = parsed[0];
    const dt = DateTime.fromJSDate(result.date()).setZone(timeZone);
    if (!dt.isValid) {
      return null;
    }
    const jsDate = dt.toJSDate();
    if (jsDate.getTime() < now.getTime()) {
      return null;
    }
    return jsDate;
  } catch (error) {
    console.warn('[DateParser] Chrono failed', error);
    return null;
  }
}
