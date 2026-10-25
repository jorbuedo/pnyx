import { describe, expect, it } from 'vitest';
import { claimWindowStart, DM_CLAIMS, mayClaim } from './dm-claim-limit.js';

describe('mayClaim', () => {
  it('allows a claimer under the cap', () => {
    expect(mayClaim(0)).toBe(true);
    expect(mayClaim(DM_CLAIMS.perPeer - 1)).toBe(true);
  });

  // The boundary is the whole rule: at the cap, the next claim is the one that must be refused.
  it('refuses at the cap and beyond', () => {
    expect(mayClaim(DM_CLAIMS.perPeer)).toBe(false);
    expect(mayClaim(DM_CLAIMS.perPeer + 1)).toBe(false);
  });

  it('takes the policy as an argument, so a test never depends on the live numbers', () => {
    expect(mayClaim(2, { perPeer: 2, windowMs: 1000 })).toBe(false);
    expect(mayClaim(1, { perPeer: 2, windowMs: 1000 })).toBe(true);
  });
});

describe('claimWindowStart', () => {
  it('is the window before now, as ISO-8601', () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    expect(claimWindowStart(now, { perPeer: 5, windowMs: 60_000 })).toBe('2026-09-01T11:59:00.000Z');
  });

  it('moves with the clock, so an old claim ages out of the count', () => {
    const early = claimWindowStart(Date.parse('2026-09-01T12:00:00.000Z'));
    const later = claimWindowStart(Date.parse('2026-09-02T12:00:00.000Z'));
    expect(later > early).toBe(true);
  });
});
