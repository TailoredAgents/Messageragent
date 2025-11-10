import { describe, expect, it } from 'vitest';

import { matchSlotSelection } from './slot-selection.ts';

const slots = [
  {
    id: 'slot-1',
    label: 'Mon Nov 10 8:00 AM–9:30 AM',
    window_start: '2025-11-10T13:00:00.000Z',
    window_end: '2025-11-10T14:30:00.000Z',
  },
  {
    id: 'slot-2',
    label: 'Mon Nov 10 2:30 PM–4:00 PM',
    window_start: '2025-11-10T19:30:00.000Z',
    window_end: '2025-11-10T21:00:00.000Z',
  },
] as const;

describe('matchSlotSelection', () => {
  it('detects explicit day/time references', () => {
    const match = matchSlotSelection({
      text: 'Let’s do Monday at 8 am',
      slots: [...slots],
      timeZone: 'America/New_York',
    });
    expect(match?.slot.id).toBe('slot-1');
  });

  it('maps ordinal phrases to slot order', () => {
    const match = matchSlotSelection({
      text: 'I’ll take the second option please.',
      slots: [...slots],
      timeZone: 'America/New_York',
    });
    expect(match?.slot.id).toBe('slot-2');
  });

  it('uses part-of-day hints when unique', () => {
    const match = matchSlotSelection({
      text: 'Book the afternoon window',
      slots: [...slots],
      timeZone: 'America/New_York',
    });
    expect(match?.slot.id).toBe('slot-2');
  });
});
