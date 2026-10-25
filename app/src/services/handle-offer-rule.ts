/**
 * The decision rule behind the handle storefront: a name and what the chain sells → what to render.
 *
 * Pure, and in its own module so a test can import the real rule rather than a copy of it — the async
 * read beside it pulls `@pnyx/midnight-native`, and through it expo-modules-core, which no unit test
 * can load.
 *
 * **Two questions, and the name's own contract answers first.** What a *tier* costs decides nothing if
 * the name is not for sale — and a name this identity already holds is not for sale to it: no permit
 * and no open tier are needed, only the `setPrimaryName` that displays it. So `held` outranks the price
 * list. Before this, the storefront priced the tier and nothing else: it offered a claim button over
 * somebody else's name (which then failed after a proof), and refused a name the user **already held**
 * whenever its tier had since been closed — which is how two preprod names became unfinishable.
 *
 * | held | tier read | name | result |
 * |---|---|---|---|
 * | any | any | fails `validateHandle` | `invalid` — decided before the chain is consulted at all |
 * | `mine` | any | valid | `yours` — nothing to buy; the claim resumes at `setPrimaryName` |
 * | `someone-else` | any | valid | `taken` |
 * | `banned` / `burned` | any | valid | `reserved` — `permanent` only for a burn |
 * | `unbound` / `unknown` | `no-namespace` | valid | `no-namespace` — this build sells nothing |
 * | `unbound` / `unknown` | `unreadable` | valid | `unknown` — ⚠️ never `unavailable`; we could not ask |
 * | `unbound` / `unknown` | `offers`, row free | valid | `free` |
 * | `unbound` / `unknown` | `offers`, row priced | valid | `priced` — free wins when a row is both |
 * | `unbound` / `unknown` | `offers`, row neither | valid | `unavailable` |
 * | `unbound` / `unknown` | `offers`, no row for the tier | valid | `unknown` — a decoder disagreeing with `handleTier` |
 *
 * @module
 */

import {encodeHandle, handleTier, validateHandle} from '@pnyx/contract-client/handle'
import type {HandleOwnership} from '@pnyx/contract-client/handle-validity'
import type {TierOffer} from '@pnyx/midnight-native'

/**
 * Who holds the name, or that we could not ask.
 *
 * `'unknown'` falls through to the price list rather than refusing: an unreadable handle contract must
 * not block a claim, and the chain refuses a name somebody else holds anyway.
 */
export type NameHeld = HandleOwnership | 'unknown'

/** What the chain said about every tier, or why it said nothing. */
export type TierRead =
  | {readonly kind: 'offers'; readonly offers: readonly TierOffer[]}
  /** No payment contract is configured, so this build has no namespace to sell from. */
  | {readonly kind: 'no-namespace'}
  /**
   * The contract could not be read.
   *
   * ⚠️ Kept apart from an empty offer list on purpose: "the tier is closed" and "we could not ask"
   * look identical on screen unless they are different values, and conflating them turns an indexer
   * outage into a definite negative about a name someone can actually have.
   */
  | {readonly kind: 'unreadable'; readonly detail: string}

/** Whether a name can be claimed on this build, and on what terms. */
export type HandleOffer =
  /**
   * Already this identity's, and not being displayed.
   *
   * ⚠️ Claimable, not a refusal: `bind` has landed and only `setPrimaryName` is missing, so the claim
   * has to be *resumable* — and it needs neither a permit nor an open tier, which is why this outranks
   * the price list rather than being a case within it.
   */
  | {readonly kind: 'yours'; readonly tier: number}
  /** Somebody else holds it. Refused before a proof rather than after one. */
  | {readonly kind: 'taken'; readonly tier: number}
  /** Banned, or burned. `permanent` is the burn — never free again, whoever asks. */
  | {readonly kind: 'reserved'; readonly tier: number; readonly permanent: boolean}
  /** Obtainable for nothing — `claimFreePermit` mints the permit `bind` then spends. */
  | {readonly kind: 'free'; readonly tier: number}
  /**
   * Obtainable, for a price in NIGHT.
   *
   * ⚠️ Reported, not offered: `buyPermit` is not on the device rail, so nothing in the app can complete
   * this. Rendering it as a price with no button is the honest shape — the alternative is a button that
   * cannot land.
   */
  | {readonly kind: 'priced'; readonly tier: number; readonly price: bigint}
  /** No row this build can read — the tier is closed, or priced in a currency it does not know. */
  | {readonly kind: 'unavailable'; readonly tier: number}
  /** Not a name that can be claimed at all. `reason` is `validateHandle`'s. */
  | {readonly kind: 'invalid'; readonly reason: string}
  /** This build has no payment contract, so it has no namespace to sell from. */
  | {readonly kind: 'no-namespace'}
  /** The chain could not be read. See {@link TierRead}. */
  | {readonly kind: 'unknown'; readonly tier?: number; readonly detail: string}

/**
 * What `name` costs, given tiers already read from the chain.
 *
 * The split the UI depends on: a name's *tier* is a function of its bytes alone, so it is known the
 * instant a character is typed, while availability needs one network read that does not change as the
 * name does. Read once, apply this per keystroke.
 */
export const offerFor = (name: string, read: TierRead, held: NameHeld = 'unknown'): HandleOffer => {
  const checked = validateHandle(name)
  if (!checked.ok) return {kind: 'invalid', reason: checked.reason}
  const tier = handleTier(encodeHandle(checked.handle))

  // The name's own contract first: it decides whether there is anything to buy at all.
  if (held === 'mine') return {kind: 'yours', tier}
  if (held === 'someone-else') return {kind: 'taken', tier}
  if (held === 'banned' || held === 'burned') return {kind: 'reserved', tier, permanent: held === 'burned'}

  if (read.kind === 'no-namespace') return {kind: 'no-namespace'}
  if (read.kind === 'unreadable') return {kind: 'unknown', tier, detail: read.detail}

  const offer = read.offers.find((o) => o.tier === tier)
  // The contract has seven tiers and the read reports all seven, so a gap is a decoder disagreeing
  // with `handleTier` rather than a closed tier — which must not render as "unavailable".
  if (offer === undefined) return {kind: 'unknown', tier, detail: `the chain reported no row for tier ${tier}`}
  // Free outranks a price: a tier can carry both rows, and charging for something being given away
  // would be the wrong way round.
  if (offer.free) return {kind: 'free', tier}
  if (offer.price !== null) return {kind: 'priced', tier, price: offer.price}
  return {kind: 'unavailable', tier}
}
