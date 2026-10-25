/**
 * Whether the row now says what a claim or release asked for.
 *
 * Its own module because the comparison is not the obvious one and it has already been wrong once. The
 * identity row carries the **display** spelling — the case its owner chose — while a claim is *for* a
 * name, which is the folded form. So `Sablewind-Harborlighted` and `sablewind-harborlighted` are the
 * same claim settling, and comparing the strings as typed never settles at all: the claim succeeds on
 * chain and the UI times out saying it did not.
 *
 * ⚠️ That was invisible until `setPrimaryName` joined the claim chain (2026-08-26). Before it, nothing
 * wrote the row, so the comparison was between `undefined` and a string and any folding rule passed.
 *
 * @module
 */

import {validateHandle} from '@pnyx/contract-client/handle'

/** The folded name, or `undefined` for anything that is not a claimable handle. */
const fold = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const checked = validateHandle(value)
  return checked.ok ? checked.handle : undefined
}

/**
 * Has a **claim** of `wanted` landed, given what the row currently reads?
 *
 * Folds both sides. `current` comes from the row (display spelling); `wanted` is what the user typed.
 */
export const claimSettled = (current: string | undefined, wanted: string): boolean => {
  const target = fold(wanted)
  // A name that does not validate cannot be claimed, so nothing can settle it — and returning `true`
  // here would report success for a claim that was never made.
  return target !== undefined && fold(current) === target
}

/**
 * Has a **release** landed? The row holds no name at all.
 *
 * Not the inverse of {@link claimSettled}: a row holding somebody *else's* name is neither this claim
 * settled nor this release settled.
 */
export const releaseSettled = (current: string | undefined): boolean => current === undefined
