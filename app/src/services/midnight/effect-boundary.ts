/**
 * Reading a Midnight-rail failure, and running one from a caller that is still Promise-based.
 *
 * ⚠️ **A tagged error's payload does not survive `Effect.runPromise`.** Measured, not assumed:
 *
 * ```
 * String(e) => (FiberFailure) UnshieldedLockError: An error has occurred
 * ```
 *
 * `Data.TaggedError` only fills `message` when the payload carries one, and most of this rail's errors
 * carry `reason` instead. So a bare `runPromise` at a Promise-side boundary replaces the indexer's, the
 * node's and storage's own words with that sentence in every log and every message on screen. The same
 * trap is documented for Cardano in `services/cardano/submit-failure.ts`, where it reached the user as
 * an unqualified "Transaction failed".
 *
 * ⚠️ **Two payload conventions meet here.** The Midnight rails say `reason`; `VaultError` and
 * `@pnyx/wallet`'s `DerivationError` say `message`. A refresh can fail either way — a cancelled
 * fingerprint is a `VaultError` — so anything rendering a rail failure has to read both.
 *
 * **Where `runMidnight` is permanent, and where it is scaffolding.** In a hook or a screen it is the
 * Effect edge the migration deliberately keeps — React does not change. Inside `services/midnight/` it
 * means *that service has not migrated yet*, so the service importers of this module are the remaining
 * work list. See `docs/EFFECT_MIGRATION.md`.
 *
 * @module
 */

import {Effect, Either} from 'effect'

/** A rail failure under either payload convention. */
export type MidnightFailure = {readonly reason: string} | {readonly message: string}

/** The failure's own words. Never invents text — the caller keeps its own wording for a shape it cannot read. */
export const midnightFailureReason = (failure: MidnightFailure): string =>
  'reason' in failure ? failure.reason : failure.message

export const runMidnight = async <A, E extends MidnightFailure>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isLeft(result)) throw new Error(midnightFailureReason(result.left))
  return result.right
}
