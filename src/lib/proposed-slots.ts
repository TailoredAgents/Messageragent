import { Prisma } from '@prisma/client';

import { ProposedSlot } from './types.ts';

export function extractProposedSlots(
  metadata: Prisma.JsonValue | null,
): ProposedSlot[] {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const raw = (metadata as Record<string, unknown>).proposed_slots;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((slot) => {
      if (!slot || typeof slot !== 'object') return null;
      const id =
        typeof (slot as Record<string, unknown>).id === 'string'
          ? (slot as Record<string, unknown>).id
          : null;
      const label =
        typeof (slot as Record<string, unknown>).label === 'string'
          ? (slot as Record<string, unknown>).label
          : '';
      const window_start =
        typeof (slot as Record<string, unknown>).window_start === 'string'
          ? (slot as Record<string, unknown>).window_start
          : null;
      const window_end =
        typeof (slot as Record<string, unknown>).window_end === 'string'
          ? (slot as Record<string, unknown>).window_end
          : null;
      if (!id || !window_start || !window_end) {
        return null;
      }
      return { id, label, window_start, window_end };
    })
    .filter((slot): slot is ProposedSlot => Boolean(slot));
}
