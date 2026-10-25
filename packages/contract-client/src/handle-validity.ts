// Whether an identity may be *displayed* under a name.
//
// **Validity is bidirectional, and neither contract can check it.** `handle(name).owner` is a claim the
// handle contract holds; `identity(C).primaryName` is a claim the identity contract holds; and
// contract-to-contract calls do not exist on Midnight, so each is written without reference to the
// other. Both `handle.compact` and `identity.compact` say so in as many words — a name pointed at
// someone who never points back is *inert*, and an owner whose row names something else is displaying
// nothing.
//
// That leaves the reader to join them, which is exactly why this is a pure function with its own tests:
// it is the only place the join happens, and getting it wrong is not cosmetic. Trusting the row alone
// lets anyone write `alice` into their own `primaryName` and be rendered as Alice; trusting the owner
// alone renders a name its holder never claimed.
//
// No `@midnight-ntwrk/compact-runtime` import — this runs on Hermes, and that package drags in the
// onchain-runtime WASM Metro cannot bundle.

import {canonicalizeHandle, decodeHandle} from './handle.js'

/** What the handle contract holds, reduced to what the rule needs. */
export type HandleFacts = {
  /** The canonical name sealed at deploy. */
  readonly name: Uint8Array
  /** The holder's `C`, or `undefined` for a deployed-but-unbound shell. */
  readonly owner: Uint8Array | undefined
  readonly banned: boolean
  readonly burned: boolean
}

/** Why a name may not be shown for an identity, or that it may. */
export type HandleValidity =
  /** Mutual, live, and mine to render. `display` is the row's spelling — the case its owner chose. */
  | {readonly kind: 'valid'; readonly display: string}
  /** The shell exists and nobody has bound it. */
  | {readonly kind: 'unbound'}
  /** Bound to a different identity than the one asked about. */
  | {readonly kind: 'other-owner'}
  /**
   * Owned by this identity, but its row does not name it back.
   *
   * ⚠️ Not an error and not a takeable name — the *holder* just is not displaying it. This is the case a
   * one-sided check gets wrong, and the case that exists in the wild right now: a `bind` that landed
   * whose `setPrimaryName` did not.
   */
  | {readonly kind: 'not-displayed'}
  /** Moderated. Live on chain and not to be rendered. */
  | {readonly kind: 'banned'}
  /** Burned — permanently unusable, and never free again. */
  | {readonly kind: 'burned'}
  /** The row names a handle this client will not render. `reason` is `decodeHandle`'s. */
  | {readonly kind: 'unrenderable'; readonly reason: string}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Who holds a name, from the handle contract's side alone. */
export type HandleOwnership =
  /** Deployed and nobody has bound it. Takeable. */
  | 'unbound'
  /** Bound to the identity asked about. */
  | 'mine'
  /** Bound to a different identity. */
  | 'someone-else'
  /** Moderated. Live on chain and not usable. */
  | 'banned'
  /** Burned — permanently unusable, and never free again. */
  | 'burned'

/**
 * Whose the name is, asked of the handle contract on its own.
 *
 * Half of {@link handleValidity}, and exported because a *claim* needs exactly this half and no more:
 * whether to bind, whether the name is already this identity's, or whether somebody else holds it.
 * `bind` asserts an unowned shell, so a claim that cannot tell "mine" from "theirs" reports the owner's
 * own name as taken and can never be finished — which is what happened to two names on preprod.
 *
 * ⚠️ `facts.owner` is **absent**, never 32 zero bytes, for a deployed-but-unbound shell. That state is
 * common, and an all-zero commitment would invite a comparison that says the name belongs to nobody's
 * identity rather than to no identity at all.
 */
export const handleOwnership = (facts: HandleFacts, identity: Uint8Array): HandleOwnership => {
  if (facts.burned) return 'burned'
  if (facts.banned) return 'banned'
  if (facts.owner === undefined) return 'unbound'
  return sameBytes(facts.owner, identity) ? 'mine' : 'someone-else'
}

/**
 * Join a handle contract's facts with an identity's row.
 *
 * `rowName` is `identity(C).primaryName` — the **display** spelling, 32 bytes, all-zero for none.
 * `identity` is the `C` being asked about. Order of checks is deliberate: burned and banned first,
 * because a name in either state must not be rendered whatever else agrees.
 */
export const handleValidity = (facts: HandleFacts, rowName: Uint8Array, identity: Uint8Array): HandleValidity => {
  // The ownership half, shared with the claim path so one comparison decides both.
  const owner = handleOwnership(facts, identity)
  if (owner === 'burned') return {kind: 'burned'}
  if (owner === 'banned') return {kind: 'banned'}
  if (owner === 'unbound') return {kind: 'unbound'}
  if (owner === 'someone-else') return {kind: 'other-owner'}

  const decoded = decodeHandle(rowName)
  // A row naming nothing, or naming bytes this client will not draw. Both mean "do not render it", and
  // the reason is worth carrying: one is ordinary, the other is the read-side handle policy at work.
  if (!decoded.ok) return {kind: 'unrenderable', reason: decoded.reason}
  // ⚠️ Folded on both sides. The row holds the case its owner chose and the contract seals the folded
  // form, so a literal comparison fails for every capitalised name — `Sablewind-Harborlighted` against
  // `sablewind-harborlighted` is one name, and this is the comparison that decides it.
  const rowCanonical = canonicalizeHandle(decoded.display)
  const sealed = decodeHandle(facts.name)
  if (!sealed.ok) return {kind: 'unrenderable', reason: sealed.reason}
  if (canonicalizeHandle(sealed.display) !== rowCanonical) return {kind: 'not-displayed'}
  return {kind: 'valid', display: decoded.display}
}
