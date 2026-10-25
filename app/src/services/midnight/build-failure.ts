/**
 * Why a Midnight transfer could not be built, in terms a caller can act on.
 *
 * One error for the build rail rather than one per module, because the *causes* are shared and the
 * decisions taken on them are too: a screen picks its copy, and the dApp connector picks a protocol
 * code. Both need the kind, not a sentence.
 *
 * ⚠️ **The distinctions here are the ones the connector spec already draws.** `invalid-recipient` and
 * `malformed-input` are the page's fault and map to `InvalidRequest`; `insufficient-funds` is the
 * wallet's inability to fulfil a well-formed request, which is its own code; `not-ready` is neither —
 * the rail has not synced, and telling a page its request was invalid would send it looking for a bug
 * it does not have. Collapsing them to `InternalError` is what `Q1` on the follow-ups board records.
 *
 * @module
 */

import type {MidnightErrorCode} from '@pnyx/dapp-connector'
import {Data} from 'effect'

export type BuildFailureCause =
  /** The recipient address is unreadable, or belongs to the other rail. */
  | 'invalid-recipient'
  /** Some other input could not be decoded — hex that is not hex, a payload of the wrong length. */
  | 'malformed-input'
  /** The wallet does not hold enough to cover it. Well-formed request, unfulfillable. */
  | 'insufficient-funds'
  /**
   * The wallet holds enough, but across more outputs than one transaction can take.
   *
   * ⚠️ **Not `insufficient-funds`.** The money is there; consolidating fixes it, and telling a user
   * they have too little would be false.
   */
  | 'too-many-inputs'
  /** A rail that has not synced yet — no shielded state, no DUST block time. Nothing is wrong. */
  | 'not-ready'

export class MidnightBuildError extends Data.TaggedError('MidnightBuildError')<{
  readonly cause: BuildFailureCause
  readonly reason: string
}> {}

/**
 * The protocol code for a build failure.
 *
 * `not-ready` is deliberately `InternalError` rather than `InvalidRequest`: the page's request was
 * fine, and this wallet simply cannot answer it yet.
 */
export const buildFailureApiCode = (cause: BuildFailureCause): MidnightErrorCode => {
  switch (cause) {
    case 'invalid-recipient':
    case 'malformed-input':
      return 'InvalidRequest'
    case 'insufficient-funds':
      return 'InsufficientFunds'
    default:
      return 'InternalError'
  }
}

/**
 * Refuse to spend from a projection that has not finished catching up.
 *
 * ⚠️ **`caughtUp` was produced, threaded through three layers, and read by nobody.** The fold computes
 * it, `UnshieldedSyncOutcome` carries it, and every money path selected from whatever the projection
 * happened to hold. From a partial history `selectUnshieldedInputs` finds too little and the caller
 * reported `insufficient-funds` — telling a user they have too little money when it simply has not been
 * counted yet. That is the same lie `too-many-inputs` exists to avoid, and `not-ready` is the cause
 * already defined for it: the request is fine, the wallet is fine, the rail is not ready.
 *
 * ⚠️ **The shielded rail had the same hole, found 2026-09-13 (plan item 62(a)).** Its branch of
 * `build-transfer.ts` checked only that a state *existed*. It bites harder there: a shielded walk is
 * bounded and starts at the wallet's birthday, so a shielded state is behind far more often than an
 * unshielded one, and the native selector's refusal — *"holds 0 of this token, need 500000"* — states a
 * balance as fact when the truth is that nothing has looked yet.
 *
 * `what` names the operation, because the cause alone cannot say whether a transfer, a funding offer or
 * a fee was being built. `rail` picks which sentence is true: the two are behind for different reasons
 * and a user fixes them differently.
 */
export const requireCaughtUp = (caughtUp: boolean, what: string, rail: 'unshielded' | 'shielded'): void => {
  if (caughtUp) return
  throw new MidnightBuildError({
    cause: 'not-ready',
    reason:
      rail === 'shielded'
        ? `${what} cannot be built while this wallet is still scanning for its shielded coins`
        : `${what} cannot be built while this wallet is still replaying its unshielded outputs`,
  })
}

/**
 * A diagnostic line for anything thrown out of the build rail.
 *
 * ⚠️ **Both of the ordinary fallbacks render a `MidnightBuildError` as nothing.** `Data.TaggedError`
 * keeps its text in `reason`, so `error.message` is `''` — and `String(error)` is the bare word
 * `MidnightBuildError`, with no cause and no reason. Measured, not assumed.
 *
 * That is how a send came to log `could not pay this send's own fee; falling back to the sponsor
 * {"error":""}`: the fallback itself was correct and the money was fine, but *why* the wallet could not
 * pay its own fee was unknowable from the log — the rule that every error path logs, satisfied to the
 * letter and not at all in substance.
 */
export const describeBuildFailure = (error: unknown): string => {
  if (error instanceof MidnightBuildError) return `${error.cause}: ${error.reason}`
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
