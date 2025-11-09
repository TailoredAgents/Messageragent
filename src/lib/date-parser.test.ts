import { describe, expect, it } from 'vitest';

import { resolvePreferredDateTime } from './date-parser.ts';

const TZ = 'America/New_York';

describe('resolvePreferredDateTime', () => {
  it('resolves relative phrases into future datetimes in the business timezone', () => {
    const anchor = new Date('2025-11-09T12:00:00-05:00');
    const resolved = resolvePreferredDateTime('this Friday at 3 pm', TZ, anchor);

    expect(resolved).not.toBeNull();
    expect(resolved?.toISOString()).toBe('2025-11-14T20:00:00.000Z');
  });

  it('returns null for blank input', () => {
    const resolved = resolvePreferredDateTime('   ', TZ, new Date());
    expect(resolved).toBeNull();
  });
});
