import { describe, expect, it } from 'vitest';
import { type ConsentInput, DEFAULT_DM_POLICY, decideConsent, isDmPolicy } from './dm-consent.js';

const input = (over: Partial<ConsentInput> = {}): ConsentInput => ({
  policy: 'open',
  blocked: false,
  permit: { kind: 'none' },
  ...over,
});

describe('decideConsent', () => {
  // ⚠️ Block outranks a permit on purpose: a permit says the recipient once agreed, a block says
  // they have since changed their mind, and the later statement wins.
  it('refuses a blocked sender whatever else is true', () => {
    for (const policy of ['open', 'permit', 'closed'] as const) {
      for (const permit of [
        { kind: 'none' },
        { kind: 'valid', notify: true },
        { kind: 'revoked' },
        { kind: 'invite', notify: true },
      ] as const) {
        expect(decideConsent(input({ policy, blocked: true, permit }))).toEqual({
          deliver: false,
          reason: 'blocked',
        });
      }
    }
  });

  it('refuses a stranger when the recipient is closed', () => {
    expect(decideConsent(input({ policy: 'closed' }))).toEqual({ deliver: false, reason: 'closed' });
  });

  // ⚠️ The setting is called "Nobody **new**", and this is what makes that true. A targeted permit is
  // the recipient's own earlier decision about one named person; the policy is about strangers. Until
  // 2026-09-02 `closed` refused here, which cut off every conversation the copy promised to keep.
  it('still admits a targeted permit under a closed policy, because it is not about strangers', () => {
    expect(decideConsent(input({ policy: 'closed', permit: { kind: 'valid', notify: true } }))).toEqual({
      deliver: true,
      notify: true,
      autoIssue: false,
      convert: false,
    });
  });

  // Muting under `closed` must not become refusing: the messages still arrive, still silently.
  it('still delivers a muted sender silently under a closed policy', () => {
    expect(decideConsent(input({ policy: 'closed', permit: { kind: 'revoked' } }))).toEqual({
      deliver: true,
      notify: false,
      autoIssue: false,
      convert: false,
    });
  });

  // The other half of "nobody new": an invite names nobody, so converting it admits a stranger.
  it('refuses to convert an invite under a closed policy', () => {
    expect(decideConsent(input({ policy: 'closed', permit: { kind: 'invite', notify: true } }))).toEqual({
      deliver: false,
      reason: 'closed',
    });
  });

  it('converts an invite under open and permit policies, and does not auto-issue as well', () => {
    for (const policy of ['open', 'permit'] as const) {
      expect(decideConsent(input({ policy, permit: { kind: 'invite', notify: true } }))).toEqual({
        deliver: true,
        notify: true,
        autoIssue: false,
        convert: true,
      });
    }
  });

  // A revoked invite reaches the rule as `none` (routes.ts), so `permit` policy answers it.
  it('carries an invite’s own notify bit into the conversion', () => {
    expect(decideConsent(input({ permit: { kind: 'invite', notify: false } }))).toMatchObject({
      notify: false,
      convert: true,
    });
  });

  it('refuses an unpermitted sender under permit policy, which is the whole setting', () => {
    expect(decideConsent(input({ policy: 'permit' }))).toEqual({ deliver: false, reason: 'permit-required' });
  });

  it('lets a permitted sender through under permit policy', () => {
    expect(decideConsent(input({ policy: 'permit', permit: { kind: 'valid', notify: true } }))).toEqual({
      deliver: true,
      notify: true,
      autoIssue: false,
      convert: false,
    });
  });

  // Auto-issue is what gives every conversation a permit id, so mute always has something to revoke.
  it('auto-issues for a stranger under an open policy', () => {
    expect(decideConsent(input({ policy: 'open' }))).toEqual({
      deliver: true,
      notify: true,
      autoIssue: true,
      convert: false,
    });
  });

  it('does not auto-issue when a valid permit was already presented', () => {
    expect(decideConsent(input({ policy: 'open', permit: { kind: 'valid', notify: true } })).deliver).toBe(true);
    expect(decideConsent(input({ policy: 'open', permit: { kind: 'valid', notify: true } }))).toMatchObject({
      autoIssue: false,
    });
  });

  // ⚠️ The distinction the whole mute design rests on: muting is not un-accepting.
  it('still delivers a muted sender, silently', () => {
    for (const policy of ['open', 'permit'] as const) {
      expect(decideConsent(input({ policy, permit: { kind: 'revoked' } }))).toEqual({
        deliver: true,
        notify: false,
        autoIssue: false,
        convert: false,
      });
    }
  });

  // If a revoked permit auto-issued a replacement, muting would un-mute on the very next message.
  it('never auto-issues over a revoked permit', () => {
    const decision = decideConsent(input({ policy: 'open', permit: { kind: 'revoked' } }));
    expect(decision).toMatchObject({ autoIssue: false });
  });

  it('carries the permit’s own notify bit rather than assuming it', () => {
    expect(decideConsent(input({ permit: { kind: 'valid', notify: false } }))).toMatchObject({ notify: false });
  });
});

describe('isDmPolicy', () => {
  it('accepts the three policies and nothing else', () => {
    expect(['open', 'permit', 'closed'].every(isDmPolicy)).toBe(true);
    for (const bad of ['OPEN', '', 'blocked', null, undefined, 1, {}]) expect(isDmPolicy(bad)).toBe(false);
  });

  // Today's behaviour is reachable-by-anyone, so that is what an unset identity must mean.
  it('defaults to open, so existing identities are unchanged', () => {
    expect(DEFAULT_DM_POLICY).toBe('open');
  });
});
