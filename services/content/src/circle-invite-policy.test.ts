import { describe, expect, it } from 'vitest';
import {
  type AccountFacts,
  accountSatisfies,
  accountSatisfiesAny,
  inviteChallengePayload,
  invitePredicateParam,
  MAX_INVITE_RULES,
  parseInvitePredicate,
  parseInvitePredicates,
} from './circle-invite-policy';

const account = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  registered: true,
  delegatedPool: null,
  delegatedDrep: null,
  controlledBalance: 1_000_000n,
  ...over,
});

describe('parseInvitePredicate', () => {
  it('reads each kind and its param', () => {
    expect(parseInvitePredicate('drep-delegated', 'drep1abc')).toEqual({
      ok: true,
      predicate: { kind: 'drep-delegated', drepId: 'drep1abc' },
    });
    expect(parseInvitePredicate('pool-member', 'pool1xyz')).toEqual({
      ok: true,
      predicate: { kind: 'pool-member', poolId: 'pool1xyz' },
    });
    expect(parseInvitePredicate('ada-threshold', '5000000')).toEqual({
      ok: true,
      predicate: { kind: 'ada-threshold', lovelace: 5_000_000n },
    });
  });

  // ⚠️ Withdrawn 2026-09-10 as a rule nobody asked for. There is deliberately no parser branch left,
  // so it refuses like any other unknown kind — a kind the UI cannot produce and the parser still
  // accepts is a rule that can only ever arrive by accident. Migration `0016` drops the stored rows.
  it('no longer knows drep-any', () => {
    expect(parseInvitePredicate('drep-any', null)).toEqual({ ok: false, error: 'unknown-kind' });
  });

  it('requires the param the kind depends on', () => {
    for (const kind of ['drep-delegated', 'pool-member', 'ada-threshold']) {
      expect(parseInvitePredicate(kind, null)).toEqual({ ok: false, error: 'param-required' });
      expect(parseInvitePredicate(kind, '')).toEqual({ ok: false, error: 'param-required' });
    }
  });

  // A threshold is exactly the value someone later sets in the billions of ADA; a float that
  // rounds the comparison is a bug with no symptom.
  it.each(['0', '-1', '1.5', '1e9', 'lots', '01'])('refuses %s as a lovelace threshold', (param) => {
    expect(parseInvitePredicate('ada-threshold', param)).toEqual({
      ok: false,
      error: 'threshold-not-a-positive-integer',
    });
  });

  it('keeps a threshold too large for a double exact', () => {
    const parsed = parseInvitePredicate('ada-threshold', '9007199254740993');
    expect(parsed.ok && parsed.predicate).toEqual({ kind: 'ada-threshold', lovelace: 9_007_199_254_740_993n });
  });

  it('refuses an unknown kind', () => {
    expect(parseInvitePredicate('owns-a-cat', null)).toEqual({ ok: false, error: 'unknown-kind' });
  });

  it('round-trips every predicate through its param column', () => {
    for (const [kind, param] of [
      ['drep-delegated', 'drep1abc'],
      ['pool-member', 'pool1xyz'],
      ['ada-threshold', '5000000'],
    ] as const) {
      const parsed = parseInvitePredicate(kind, param);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(invitePredicateParam(parsed.predicate)).toBe(param);
      }
    }
  });
});

describe('accountSatisfies', () => {
  it('admits an account matching each predicate', () => {
    expect(accountSatisfies({ kind: 'drep-delegated', drepId: 'drep1x' }, account({ delegatedDrep: 'drep1x' }))).toEqual({
      ok: true,
    });
    expect(accountSatisfies({ kind: 'pool-member', poolId: 'pool1a' }, account({ delegatedPool: 'pool1a' }))).toEqual({
      ok: true,
    });
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 10n }, account({ controlledBalance: 10n }))).toEqual({
      ok: true,
    });
  });

  it('refuses a delegation to a different drep or pool', () => {
    expect(accountSatisfies({ kind: 'drep-delegated', drepId: 'drep1x' }, account({ delegatedDrep: 'drep1y' }))).toEqual({
      ok: false,
      failure: 'not-delegated-to-that-drep',
    });
    expect(accountSatisfies({ kind: 'pool-member', poolId: 'pool1a' }, account({ delegatedPool: 'pool1b' }))).toEqual({
      ok: false,
      failure: 'not-in-that-pool',
    });
  });

  // `delegated_pool` and `delegated_drep` are properties of a *registered* stake account and mean
  // nothing without one.
  it('fails the delegation rules on an unregistered stake key, with that reason', () => {
    const unregistered = account({ registered: false, delegatedDrep: 'drep1x', delegatedPool: 'pool1a' });
    for (const predicate of [
      { kind: 'drep-delegated', drepId: 'drep1x' },
      { kind: 'pool-member', poolId: 'pool1a' },
    ] as const) {
      expect(accountSatisfies(predicate, unregistered)).toEqual({ ok: false, failure: 'stake-key-not-registered' });
    }
  });

  // ⚠️ **The balance rule does not require registration**, corrected 2026-09-11. Measured against
  // live Koios: 9 of 18 unregistered accounts in a 100-account sample report a real `total_balance`,
  // so the chain *has* seen them. A founder's rule says "holding at least this much ADA" — refusing a
  // funded wallet over registration answers a question they did not ask.
  it('admits an unregistered stake key that holds enough ADA', () => {
    const funded = account({ registered: false, controlledBalance: 10n ** 12n });
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 1n }, funded)).toEqual({ ok: true });
  });

  // The rule is still a rule: unregistered does not mean exempt.
  it('still refuses an unregistered stake key below the threshold', () => {
    const poor = account({ registered: false, controlledBalance: 1n });
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 100n }, poor)).toEqual({
      ok: false,
      failure: 'below-ada-threshold',
    });
  });

  // A figure we do not have is not a figure of zero. Substituting one refuses a qualifying wallet
  // with a message telling them they are poor.
  it('reports a null balance as unknown rather than as zero', () => {
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 1n }, account({ controlledBalance: null }))).toEqual({
      ok: false,
      failure: 'balance-unknown',
    });
  });

  // The field being absent altogether, rather than present and null — the provider marks it
  // optional, so both shapes reach here and both must refuse rather than read as zero.
  it('reports an omitted balance as unknown rather than as zero', () => {
    const facts: AccountFacts = { registered: true, delegatedPool: null, delegatedDrep: null };
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 1n }, facts)).toEqual({
      ok: false,
      failure: 'balance-unknown',
    });
  });

  it('treats the threshold as inclusive', () => {
    expect(accountSatisfies({ kind: 'ada-threshold', lovelace: 100n }, account({ controlledBalance: 99n }))).toEqual({
      ok: false,
      failure: 'below-ada-threshold',
    });
  });
});

describe('parseInvitePredicates', () => {
  it('reads a set', () => {
    const parsed = parseInvitePredicates([
      { kind: 'pool-member', param: 'pool1a' },
      { kind: 'ada-threshold', param: '10' },
    ]);
    expect(parsed.ok && parsed.predicates).toEqual([
      { kind: 'pool-member', poolId: 'pool1a' },
      { kind: 'ada-threshold', lovelace: 10n },
    ]);
  });

  // ⚠️ Under any-of the looser of two same-kind rules silently wins, so a founder who meant to edit
  // one and added another would quietly widen their gate. Refused rather than resolved.
  it('refuses the same kind twice', () => {
    expect(
      parseInvitePredicates([
        { kind: 'ada-threshold', param: '10' },
        { kind: 'ada-threshold', param: '5' },
      ]),
    ).toEqual({ ok: false, error: 'duplicate-kind' });
  });

  // An empty set admits nobody, which is a thing to say by clearing the policy rather than by storing
  // a gate that can never open.
  it('refuses an empty set', () => {
    expect(parseInvitePredicates([])).toEqual({ ok: false, error: 'no-rules' });
  });

  it('refuses more rules than there are kinds to fill them', () => {
    const many = Array.from({ length: MAX_INVITE_RULES + 1 }, (_, i) => ({ kind: `k${i}`, param: null }));
    expect(parseInvitePredicates(many)).toEqual({ ok: false, error: 'too-many-rules' });
  });

  it('reports the first bad rule rather than the set', () => {
    expect(
      parseInvitePredicates([
        { kind: 'pool-member', param: 'pool1a' },
        { kind: 'ada-threshold', param: 'lots' },
      ]),
    ).toEqual({ ok: false, error: 'threshold-not-a-positive-integer' });
  });
});

describe('accountSatisfiesAny', () => {
  const POOL = { kind: 'pool-member', poolId: 'pool1a' } as const;
  const ADA = { kind: 'ada-threshold', lovelace: 10n } as const;

  // The whole point of a set: meeting one is enough.
  it('admits an account that meets the second rule but not the first', () => {
    expect(accountSatisfiesAny([POOL, ADA], account({ delegatedPool: 'pool1z', controlledBalance: 10n }))).toEqual({
      ok: true,
    });
  });

  it('admits an account that meets the first and never evaluates further', () => {
    expect(accountSatisfiesAny([ADA, POOL], account({ controlledBalance: 99n }))).toEqual({ ok: true });
  });

  // ⚠️ **Every failure, not the first.** With several requirements "you do not qualify" is not an
  // answer — the useful answer is which of the several things to go and do.
  it('reports one failure per rule, in order', () => {
    expect(accountSatisfiesAny([POOL, ADA], account({ delegatedPool: 'pool1z', controlledBalance: 1n }))).toEqual({
      ok: false,
      failures: ['not-in-that-pool', 'below-ada-threshold'],
    });
  });

  // A set that admits nobody must not admit everybody, which is what a bare `.some()` over an empty
  // array would have done in reverse — and what an `.every()` would have done outright.
  it('refuses an empty set rather than passing vacuously', () => {
    expect(accountSatisfiesAny([], account({ controlledBalance: 10n ** 12n }))).toEqual({ ok: false, failures: [] });
  });

  // The pool rule needs registration; the balance rule does not — so an unregistered wallet with
  // nothing in it fails them for two *different* reasons, which is what the caller shows the user.
  it('reports the right reason per rule for an unregistered, empty stake key', () => {
    expect(accountSatisfiesAny([POOL, ADA], account({ registered: false, controlledBalance: 0n }))).toEqual({
      ok: false,
      failures: ['stake-key-not-registered', 'below-ada-threshold'],
    });
  });

  // And an unregistered wallet that holds enough gets in on the balance rule alone.
  it('admits an unregistered stake key on the balance rule', () => {
    expect(accountSatisfiesAny([POOL, ADA], account({ registered: false, controlledBalance: 10n }))).toEqual({
      ok: true,
    });
  });
});

describe('inviteChallengePayload', () => {
  // Every field that makes this un-replayable has to be inside the signed string: a sender who can
  // rewrite the nonce, the circle or the expiry is not defended by them.
  it('binds the domain, circle, nonce and expiry into one string', () => {
    expect(inviteChallengePayload({ circleId: 'c-1', nonce: 'abc', expiresAtMs: 1700 })).toBe(
      'pnyx:circle-invite.v1.c-1.abc.1700',
    );
  });

  it('gives two circles different bytes for the same nonce', () => {
    const a = inviteChallengePayload({ circleId: 'c-1', nonce: 'abc', expiresAtMs: 1700 });
    const b = inviteChallengePayload({ circleId: 'c-2', nonce: 'abc', expiresAtMs: 1700 });
    expect(a).not.toBe(b);
  });
});
