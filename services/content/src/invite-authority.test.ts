// The per-circle invite authority: what it must never do, mostly.
//
// Three properties carry the whole design, and each one has a concrete failure behind it:
//
//   - **per circle** — two circles must never share a secret, or one leak opens every gated circle
//     that ever delegated to this deployment
//   - **domain-separated from the commitment** — hashing the root under `pnyx:ia` would make the root
//     itself a valid authority secret for a circle committed to `H("pnyx:ia", root)`
//   - **refused, never coerced** — a root of the wrong length would derive perfectly valid-looking
//     secrets that are simply not the ones any circle committed to
import { describe, expect, it } from 'vitest';
import { inviteAuthorityCommitment } from '@pnyx/contract-client/circle-derivations';
import { inviteAuthorityCommitmentFor, inviteAuthoritySk, parseInviteAuthorityRoot } from './invite-authority.js';

const ROOT = new Uint8Array(32).fill(7);
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('parseInviteAuthorityRoot', () => {
  it('accepts 64 hex characters, in either case', () => {
    const lower = parseInviteAuthorityRoot('ab'.repeat(32));
    const upper = parseInviteAuthorityRoot('AB'.repeat(32));
    expect(lower.ok && upper.ok).toBe(true);
    expect(lower.ok && upper.ok && toHex(lower.root)).toBe(lower.ok && upper.ok ? toHex(upper.root) : '');
  });

  // ⚠️ Refused rather than padded or truncated. A silently coerced root derives secrets that look
  // fine and fail at the contract as "not the invite authority" — a sentence several layers from the
  // typo that caused it.
  it.each(['', 'ab', 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), `${'ab'.repeat(31)}a`])(
    'refuses %s',
    (bad) => {
      expect(parseInviteAuthorityRoot(bad).ok).toBe(false);
    },
  );
});

describe('inviteAuthoritySk', () => {
  it('is different for every circle', () => {
    const a = inviteAuthoritySk(ROOT, 'circle-a');
    const b = inviteAuthoritySk(ROOT, 'circle-b');
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('is stable for one circle', () => {
    expect(toHex(inviteAuthoritySk(ROOT, 'circle-a'))).toBe(toHex(inviteAuthoritySk(ROOT, 'circle-a')));
  });

  it('changes with the root', () => {
    const other = new Uint8Array(32).fill(8);
    expect(toHex(inviteAuthoritySk(ROOT, 'c'))).not.toBe(toHex(inviteAuthoritySk(other, 'c')));
  });

  // ⚠️ The tag that derives the secret is not the tag that commits to it. Colliding them would make
  // the root a usable authority secret for a circle whose commitment is `H("pnyx:ia", root)`.
  it('is never the commitment of the root itself', () => {
    expect(toHex(inviteAuthoritySk(ROOT, 'c'))).not.toBe(toHex(inviteAuthorityCommitment(ROOT)));
  });

  it('refuses a root that is not 32 bytes', () => {
    expect(() => inviteAuthoritySk(new Uint8Array(31), 'c')).toThrow(/32 bytes/);
  });
});

describe('inviteAuthorityCommitmentFor', () => {
  // What the founder posts with `setInviteAuthority`, and what the contract compares against — so it
  // has to be `circle.compact`'s own derivation over our secret and nothing adjacent to it.
  it('is the contract’s commitment of this circle’s secret', () => {
    expect(inviteAuthorityCommitmentFor(ROOT, 'circle-a')).toBe(
      toHex(inviteAuthorityCommitment(inviteAuthoritySk(ROOT, 'circle-a'))),
    );
  });

  it('is 64 lowercase hex characters, which is what the routes validate', () => {
    expect(inviteAuthorityCommitmentFor(ROOT, 'circle-a')).toMatch(/^[0-9a-f]{64}$/);
  });
});
