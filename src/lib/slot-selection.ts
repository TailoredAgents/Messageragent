import { DateTime } from 'luxon';

import { ProposedSlot } from './types.ts';

export type SlotMatchReason =
  | 'time_match'
  | 'label_match'
  | 'ordinal_match'
  | 'part_of_day_match';

export type SlotMatchResult = {
  slot: ProposedSlot;
  reason: SlotMatchReason;
};

const DEFAULT_TZ = 'America/New_York';
const ORDINAL_PATTERNS: Array<{ keywords: string[]; index: number }> = [
  { keywords: ['first', '1st', 'earlier', 'earliest', 'the first one'], index: 0 },
  { keywords: ['second', '2nd', 'later', 'the second one'], index: 1 },
  { keywords: ['third', '3rd', 'the third one'], index: 2 },
  { keywords: ['fourth', '4th', 'the fourth one'], index: 3 },
];

type NormalizedSlot = {
  slot: ProposedSlot;
  index: number;
  dayTokens: string[];
  timeTokens: string[];
  partOfDay: 'morning' | 'afternoon' | 'evening';
  labelToken: string;
};

export function matchSlotSelection({
  text,
  slots,
  timeZone = DEFAULT_TZ,
}: {
  text: string;
  slots: ProposedSlot[];
  timeZone?: string;
}): SlotMatchResult | null {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText || slots.length === 0) {
    return null;
  }

  const normalizedSlots = slots.map<NormalizedSlot>((slot, index) => {
    const date = DateTime.fromISO(slot.window_start).setZone(timeZone);
    const dayTokens = [
      date.toFormat('cccc').toLowerCase(), // Monday
      date.toFormat('ccc').toLowerCase(), // Mon
      date.toFormat('cccc, LLL d').toLowerCase(),
      date.toFormat('LLL d').toLowerCase(),
      date.toFormat('LLLL d').toLowerCase(),
    ];
    const meridiem = date.toFormat('a').toLowerCase(); // am
    const hour = date.toFormat('h'); // 8
    const minute = date.toFormat('mm'); // 00
    const timeTokens = [
      date.toFormat('h:mm a').toLowerCase(), // 8:00 am
      date.toFormat('h:mm').toLowerCase(), // 8:00
      `${hour} ${meridiem}`,
      `${hour}${meridiem}`,
      `${hour}:${minute}${meridiem}`,
      `${hour}${meridiem.charAt(0)}`,
      `${hour} ${meridiem.charAt(0)}`,
    ];
    if (minute === '00') {
      timeTokens.push(`${hour} o'clock ${meridiem}`);
      timeTokens.push(`${hour} oclock ${meridiem}`);
    }
    const partOfDay =
      date.hour < 12 ? 'morning' : date.hour < 17 ? 'afternoon' : 'evening';
    return {
      slot,
      index,
      dayTokens,
      timeTokens,
      partOfDay,
      labelToken: (slot.label ?? '').toLowerCase(),
    };
  });

  const ordinalMatch = detectOrdinalPreference(normalizedText, slots.length);
  if (ordinalMatch !== null) {
    return {
      slot: slots[ordinalMatch],
      reason: 'ordinal_match',
    };
  }

  for (const normalized of normalizedSlots) {
    if (normalized.labelToken && normalizedText.includes(normalized.labelToken)) {
      return { slot: normalized.slot, reason: 'label_match' };
    }

    const dayHit = normalized.dayTokens.some((token) =>
      token && normalizedText.includes(token),
    );
    const timeHit = normalized.timeTokens.some((token) =>
      token && normalizedText.includes(token),
    );
    if (dayHit && timeHit) {
      return { slot: normalized.slot, reason: 'time_match' };
    }

    if (
      timeHit &&
      hasUniqueTimeToken(normalized.slot, normalizedSlots, normalized.timeTokens)
    ) {
      return { slot: normalized.slot, reason: 'time_match' };
    }

    if (
      normalizedText.includes(normalized.partOfDay) &&
      partOfDayIsDistinct(normalized.partOfDay, normalizedSlots)
    ) {
      return { slot: normalized.slot, reason: 'part_of_day_match' };
    }
  }

  return null;
}

function detectOrdinalPreference(
  text: string,
  slotCount: number,
): number | null {
  for (const { keywords, index } of ORDINAL_PATTERNS) {
    if (index >= slotCount) continue;
    if (keywords.some((keyword) => text.includes(keyword))) {
      return index;
    }
  }
  if (text.includes('earlier') && slotCount > 0) return 0;
  if (text.includes('later') && slotCount > 1) return slotCount - 1;
  if (text.includes('morning') && slotCount > 0) return 0;
  if (text.includes('afternoon') && slotCount > 1) return Math.min(1, slotCount - 1);
  if (text.includes('evening')) return slotCount - 1;
  return null;
}

function partOfDayIsDistinct(
  part: 'morning' | 'afternoon' | 'evening',
  slots: NormalizedSlot[],
): boolean {
  const matches = slots.filter((slot) => slot.partOfDay === part);
  return matches.length === 1;
}

function hasUniqueTimeToken(
  slot: ProposedSlot,
  slots: NormalizedSlot[],
  timeTokens: string[],
): boolean {
  const otherSlots = slots.filter((normalized) => normalized.slot.id !== slot.id);
  return timeTokens.some((token) => {
    if (!token) return false;
    return otherSlots.every(
      (candidate) =>
        !candidate.timeTokens.some((otherToken) => otherToken.includes(token)),
    );
  });
}
