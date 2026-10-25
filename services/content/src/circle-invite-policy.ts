// What a circle demands of a stake key before the attestor will hand over an invite.
//
// ## Why an attestor exists at all
//
// A Compact circuit on Midnight cannot read Cardano's ledger (`docs/BOUNDED_STATE_ARCHITECTURE.md`
// §"Gating a circle is an **invite**"). Delegation, pool membership, DRep status and balance are
// none of them visible in-circuit, so every predicate worth gating on needs someone off-chain to
// check it — and the chain enforces the only half it can: that you hold an unspent invite.
//
// So this module is the *policy* half. It is pure: predicates are parsed and evaluated against an
// `AccountInfo` a caller fetched, and nothing here reaches a network or a database. That is what
// lets the rules be tested without either.
//
// ⚠️ **An invite is a snapshot, not a subscription.** Passing the predicate once buys a code that
// stays valid; it does not lapse when the holder redelegates. `setInvite(c, false)` is the tool for
// periodic re-checks, and there is deliberately no automatic expiry — a member silently losing
// access because a pool retired is not a thing a circle should do without saying so.
//
// ⚠️ **Sybil resistance varies by predicate and is the circle's problem, not ours.** An ADA
// threshold splits trivially across wallets. "Is a DRep" and "delegates to DRep X" are identities
// with their own costs. `describeInvitePredicate` exists so the app can state the rule plainly
// rather than implying a guarantee the rule does not carry.

/** Total controlled lovelace and the delegation facts, as the provider reports them. */
export type AccountFacts = {
  readonly registered: boolean;
  readonly delegatedPool: string | null;
  readonly delegatedDrep: string | null;
  readonly controlledBalance?: bigint | null;
};

/**
 * The predicates a circle may gate on.
 *
 * All three are answered by one `account_info` call, which is why they are the first set: the cost
 * of checking is one request whatever the rule, and adding a fourth that needs a second endpoint is
 * a different conversation.
 *
 * ⚠️ **`drep-any` was removed on 2026-09-10** — "delegating to any DRep at all" was a rule nobody
 * asked for, and every predicate here has to be one a founder would actually choose. Migration
 * `0016` drops the rows; there is deliberately no parser branch left to read one back, because a
 * kind the UI cannot produce and the parser still accepts is a rule that can only arrive by accident.
 */
export type InvitePredicate =
  /** Delegating to one specific DRep. `param` is the DRep id. */
  | { readonly kind: 'drep-delegated'; readonly drepId: string }
  /** Delegating to one specific stake pool. `param` is the bech32 pool id. */
  | { readonly kind: 'pool-member'; readonly poolId: string }
  /** Holding at least `lovelace` of controlled ADA. */
  | { readonly kind: 'ada-threshold'; readonly lovelace: bigint };

export type PredicateParseError =
  | 'unknown-kind'
  | 'param-required'
  | 'threshold-not-a-positive-integer'
  | 'no-rules'
  | 'too-many-rules'
  | 'duplicate-kind';

/**
 * How many rules one circle may carry.
 *
 * The cap is the predicate set itself: every kind is answered by the same `account_info` call, so
 * more rules than kinds can only mean a repeat, and a repeat is refused separately. Bounded anyway,
 * because an unbounded list from a client is an unbounded list.
 */
export const MAX_INVITE_RULES = 8;

/**
 * Parse a stored or submitted predicate.
 *
 * `kind` + a single `param` rather than a discriminated JSON blob because that is what the row
 * holds, and one column that means different things per kind is easier to read back than a schema
 * that has to be migrated every time a predicate is added.
 *
 * Returns the error rather than throwing: every branch is an ordinary 400 the route has to word.
 */
export const parseInvitePredicate = (
  kind: string,
  param: string | null,
): { readonly ok: true; readonly predicate: InvitePredicate } | { readonly ok: false; readonly error: PredicateParseError } => {
  switch (kind) {
    case 'drep-delegated':
      return param === null || param === ''
        ? { ok: false, error: 'param-required' }
        : { ok: true, predicate: { kind: 'drep-delegated', drepId: param } };
    case 'pool-member':
      return param === null || param === ''
        ? { ok: false, error: 'param-required' }
        : { ok: true, predicate: { kind: 'pool-member', poolId: param } };
    case 'ada-threshold': {
      if (param === null || param === '') {
        return { ok: false, error: 'param-required' };
      }
      // Lovelace, as a decimal string. Not a JSON number: 45 000 000 000 000 lovelace exceeds
      // nothing today, but a threshold is exactly the kind of value someone later sets in the
      // billions of ADA, and a float that rounds a balance comparison is a bug with no symptom.
      if (!/^[1-9][0-9]{0,20}$/.test(param)) {
        return { ok: false, error: 'threshold-not-a-positive-integer' };
      }
      return { ok: true, predicate: { kind: 'ada-threshold', lovelace: BigInt(param) } };
    }
    default:
      return { ok: false, error: 'unknown-kind' };
  }
};

/** The `param` column for a predicate — the inverse of {@link parseInvitePredicate}. */
export const invitePredicateParam = (predicate: InvitePredicate): string | null => {
  switch (predicate.kind) {
    case 'drep-delegated':
      return predicate.drepId;
    case 'pool-member':
      return predicate.poolId;
    case 'ada-threshold':
      return predicate.lovelace.toString();
  }
};

/** Why an account did not qualify. Each is something the app says to the user verbatim. */
export type PredicateFailure =
  | 'stake-key-not-registered'
  | 'not-delegated-to-that-drep'
  | 'not-in-that-pool'
  | 'below-ada-threshold'
  | 'balance-unknown';

/**
 * Whether an account satisfies the predicate.
 *
 * ⚠️ **Registration gates the delegation rules and NOT the balance rule**, corrected 2026-09-11.
 * It used to gate all three, on the reasoning that "a balance read for a key the chain has never
 * seen is not a small balance — it is an absence". That is true of delegation and **false of the
 * balance**: measured against live Koios, 9 of 18 unregistered accounts in a 100-account sample
 * report a real `total_balance`. So the chain *has* seen them, and refusing a funded wallet with a
 * message about registration answers a question the founder did not ask — their rule says "holding
 * at least this much ADA", not "holding it and having registered".
 *
 * The two delegation rules still require it, and for the original reason: `delegated_pool` and
 * `delegated_drep` are properties of a registered stake account and mean nothing without one.
 *
 * ⚠️ **`controlledBalance` absent is refused, never treated as zero.** The provider marks it
 * optional because not every backend reports it; a missing figure is a fact we do not have, and
 * substituting `0n` would refuse a qualifying wallet with a message telling them they are poor.
 */
export const accountSatisfies = (
  predicate: InvitePredicate,
  account: AccountFacts,
): { readonly ok: true } | { readonly ok: false; readonly failure: PredicateFailure } => {
  if (!account.registered && predicate.kind !== 'ada-threshold') {
    return { ok: false, failure: 'stake-key-not-registered' };
  }
  switch (predicate.kind) {
    case 'drep-delegated':
      return account.delegatedDrep === predicate.drepId ? { ok: true } : { ok: false, failure: 'not-delegated-to-that-drep' };
    case 'pool-member':
      return account.delegatedPool === predicate.poolId ? { ok: true } : { ok: false, failure: 'not-in-that-pool' };
    case 'ada-threshold': {
      const balance = account.controlledBalance;
      if (balance === undefined || balance === null) {
        return { ok: false, failure: 'balance-unknown' };
      }
      return balance >= predicate.lovelace ? { ok: true } : { ok: false, failure: 'below-ada-threshold' };
    }
  }
};

/**
 * Parse the whole rule set a founder submitted, or a circle stored.
 *
 * ⚠️ **One kind at most once.** Two `ada-threshold` rules is a founder who meant to edit one and
 * added another, and under any-of semantics the lower one silently wins — so it is refused rather
 * than resolved. The same argument does not apply across kinds, which is the whole point of a set.
 */
export const parseInvitePredicates = (
  raw: readonly { readonly kind: string; readonly param: string | null }[],
):
  | { readonly ok: true; readonly predicates: readonly InvitePredicate[] }
  | { readonly ok: false; readonly error: PredicateParseError } => {
  if (raw.length === 0) return { ok: false, error: 'no-rules' };
  if (raw.length > MAX_INVITE_RULES) return { ok: false, error: 'too-many-rules' };
  const predicates: InvitePredicate[] = [];
  const seen = new Set<string>();
  for (const one of raw) {
    if (seen.has(one.kind)) return { ok: false, error: 'duplicate-kind' };
    seen.add(one.kind);
    const parsed = parseInvitePredicate(one.kind, one.param);
    if (!parsed.ok) return parsed;
    predicates.push(parsed.predicate);
  }
  return { ok: true, predicates };
};

/**
 * Whether an account satisfies **any** of a circle's rules.
 *
 * ⚠️ **Any, not all — and that is a product decision, not an implementation detail.** The founder's
 * question is "who may join", and a list under that heading reads as a list of groups who may. All-of
 * would make two rules strictly narrower than one, so a founder adding a second rule to widen their
 * circle would quietly close it. The app states the rule ("anyone who meets one of these") rather
 * than leaving it to be inferred.
 *
 * The failures come back **in full**, one per rule in order, because with several rules "you do not
 * qualify" is not an answer — the useful answer is which of the several things to go and do. An
 * empty rule set cannot admit anyone and is refused as such rather than vacuously passing.
 */
export const accountSatisfiesAny = (
  predicates: readonly InvitePredicate[],
  account: AccountFacts,
): { readonly ok: true } | { readonly ok: false; readonly failures: readonly PredicateFailure[] } => {
  if (predicates.length === 0) return { ok: false, failures: [] };
  const failures: PredicateFailure[] = [];
  for (const predicate of predicates) {
    const verdict = accountSatisfies(predicate, account);
    if (verdict.ok) return { ok: true };
    failures.push(verdict.failure);
  }
  return { ok: false, failures };
};

/**
 * The exact bytes a requester signs with their stake key.
 *
 * ⚠️ **Every field that makes this un-replayable is *inside* the signed string.** A nonce the
 * server issued (so it cannot be minted by the sender), the circle id (so a signature for one
 * circle cannot claim an invite in another), an expiry (so a captured signature dies), and a
 * domain tag (so this cannot be confused with the Koios, SteelSwap or bug-report challenges the
 * same wallet signs). A replay defence the sender can rewrite is not one — the same rule
 * `packages/crypto/signed-upload.ts` states for uploads.
 *
 * `.`-joined and `.`-free in every field, so no two field sets can produce the same string.
 */
export const INVITE_REQUEST_DOMAIN = 'pnyx:circle-invite';

export const inviteChallengePayload = (fields: {
  readonly circleId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
}): string => `${INVITE_REQUEST_DOMAIN}.v1.${fields.circleId}.${fields.nonce}.${fields.expiresAtMs}`;
