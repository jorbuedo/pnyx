/**
 * Which name an identity holds, for the manage screen.
 *
 * ⚠️ **The chain cannot be asked this.** A handle's contract address derives from the *name*, so
 * ownership is checkable if you know the name and not enumerable from an identity — the registry that
 * would have answered it was removed because reading it did not scale
 * (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1).
 *
 * So the one name there is comes from `identity(C).primaryName`, which the row carries anyway and is
 * therefore free. ⚠️ **It is a *claim*, not authority** — the contract does not validate that field —
 * so it still has to be checked against `handle(name).owner == C` before being rendered as owned,
 * which is what {@link HeldName.status} carries.
 *
 * ⚠️ There used to be a second source: `CardKind.PnyxName` rows, a self-maintained index of the
 * *other* names an identity held. Removed 2026-10-13 — the product caps a holder at one name, so it
 * indexed a set with one member that `primaryName` already carried, and it published that index to
 * anyone who could read the card.
 *
 * @module
 */

import {canonicalizeHandle, validateHandle} from '@pnyx/contract-client/handle'

export type HeldNameStatus =
  /** `handle(name).owner` is this identity, both directions agree. */
  | 'owned'
  /** The row names it, but the handle contract says otherwise — stale, or never true. */
  | 'not-owned'
  /** The handle contract could not be read. ⚠️ Not `not-owned`: an outage is not a disclaimer. */
  | 'unknown'

export type HeldName = {
  /** The canonical (folded) spelling — what an address derives from, and what dedupes the list. */
  readonly canonical: string
  /** The spelling to show, which is the one the row recorded. */
  readonly display: string
  readonly status: HeldNameStatus
  /** Whether `identity(C).primaryName` points at this one. */
  readonly active: boolean
}

/**
 * The names this identity holds, as a list of one — or none.
 *
 * ⚠️ **A list rather than a scalar on purpose.** The manage screen renders rows, and the product
 * rule capping a holder at one name is a *product* rule: the handle contract permits an identity to
 * bind several, so a shape that cannot express two would have to be reworked rather than extended if
 * that ever changes. The validity check stays too — a row naming bytes that are not a claimable name
 * cannot be a name this identity holds.
 */
export const mergeHeldNames = (params: {
  readonly activeName: string | undefined
  readonly statusOf: (canonical: string) => HeldNameStatus
}): readonly HeldName[] => {
  if (params.activeName === undefined) return []
  const checked = validateHandle(params.activeName)
  if (!checked.ok) return []
  const canonical = canonicalizeHandle(params.activeName)
  return [{canonical, display: checked.display, status: params.statusOf(canonical), active: true}]
}
