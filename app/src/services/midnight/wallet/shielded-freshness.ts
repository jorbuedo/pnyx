/**
 * May a shielded transfer be built from the state this device holds?
 *
 * Its own module because it is a decision rather than an effect, and because the answer is not
 * obvious in either direction — the two ways of getting it wrong cost different things.
 *
 * | cursor | tip | verdict | why |
 * |---|---|---|---|
 * | absent | any | `never-synced` | nothing has looked; a balance of nothing is not a fact |
 * | `>= tip - {@link BUILD_LAG_TOLERANCE_BLOCKS}` | read | `current` | build |
 * | further below | read | `behind` | blocks this device has not seen may hold the very coins being spent |
 * | any | unreadable | `unknown` | **build anyway**, and say so |
 *
 * ⚠️ **`behind` refuses, and that is the point of the module** (plan item 62(a)). The native selector
 * answers a short balance with *"holds 0 of this token, need 500000"* — a statement about the wallet,
 * when the truth is a statement about the scan. It is the same lie `too-many-inputs` was split out of
 * `insufficient-funds` to avoid, and the unshielded rail already refuses for it (`requireCaughtUp`).
 *
 * ⚠️ **`unknown` builds, and that asymmetry is deliberate.** A coin in the local state was applied from
 * a confirmed block and its tree root was checked against the chain, so it is spendable whatever the
 * indexer is doing now. Refusing would turn an indexer hiccup into a wallet that cannot spend money it
 * provably holds — a worse failure than the lie, which only appears when the amount exceeds what is
 * held. It is logged rather than silent, because "we did not check" and "we checked and it was fine"
 * are different facts.
 *
 * ⚠️ **`current` carries a tolerance, and without one this rail could not send at all.** Measured on
 * preprod 2026-09-14: a walk that finished at the tip was **one block behind** by the time the user
 * reached the review, and the build refused — twice, from a wallet holding the coin. An exact
 * `cursor >= tip` asks a person to type an address, an amount and read a review inside one block. The tolerance is what the rule is actually about: it
 * refuses a device that never looked at the *thousands* of blocks a coin could be hiding in, not one
 * that is a minute behind a chain nobody can outrun.
 *
 * @module
 */

/**
 * How far below the tip still counts as caught up.
 *
 * Preprod makes a block every ~2.6 s (measured 2026-09-14: 92 blocks in four minutes), so a hundred
 * blocks is about four minutes — long enough that finishing a sync and then typing an address, an
 * amount and reading a review cannot fail, and short enough that the case this rule exists for is
 * still refused: a wallet behind by the tens of thousands of blocks a coin could be hiding in, which
 * the native selector reports as *"holds 0 of this token"* about money the user has.
 */
export const BUILD_LAG_TOLERANCE_BLOCKS = 100

export type ShieldedFreshness =
  /** Caught up to the tip; a build may proceed. */
  | {readonly kind: 'current'; readonly cursor: number}
  /** Behind the tip by a known amount. A build must refuse. */
  | {readonly kind: 'behind'; readonly cursor: number; readonly tip: number}
  /** No cursor at all — this wallet has never scanned. */
  | {readonly kind: 'never-synced'}
  /** The tip could not be read, so freshness is unestablished. A build proceeds, loudly. */
  | {readonly kind: 'unknown'; readonly cursor: number; readonly reason: string}

export const shieldedFreshness = (params: {
  /** The last height applied to the stored state, or `undefined` if it has never synced. */
  readonly cursor: number | undefined
  /** The chain tip, or `null` when it could not be read — never `0`, which is a height. */
  readonly tip: number | null
  /** Why the tip is `null`, for the `unknown` verdict to carry. */
  readonly tipFailure?: string
}): ShieldedFreshness => {
  const {cursor, tip} = params
  if (cursor === undefined) return {kind: 'never-synced'}
  if (tip === null) {
    return {kind: 'unknown', cursor, reason: params.tipFailure ?? 'the chain tip could not be read'}
  }
  return cursor >= tip - BUILD_LAG_TOLERANCE_BLOCKS ? {kind: 'current', cursor} : {kind: 'behind', cursor, tip}
}

/** Whether a build may proceed. Separate from the verdict so a caller cannot forget a case. */
export const freshnessAllowsBuild = (freshness: ShieldedFreshness): boolean =>
  freshness.kind === 'current' || freshness.kind === 'unknown'
