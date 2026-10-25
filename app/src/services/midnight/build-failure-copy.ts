/**
 * Which sentence a user sees when a Midnight transfer could not be built.
 *
 * ⚠️ **The review screen used to render `describeBuildFailure` verbatim**, which is a *diagnostic*:
 * it prints `cause: reason`, so the callout read **"not-ready: a shielded transfer cannot be built
 * while this wallet is still scanning for its shielded coins"** — an internal cause tag and a
 * hardcoded English sentence, in the one place the app promises neither. Every string a user reads
 * goes through `t()`, and the cause belongs in the log beside it, not in front of them.
 *
 * So this maps a thrown value to a **key**, and the screen owns the copy. The raw text keeps going to
 * the logger unchanged — the two audiences want different things and always did.
 *
 * | cause | key | what the user is told |
 * |---|---|---|
 * | `invalid-recipient` | `invalidRecipient` | the address is not one this rail can pay |
 * | `malformed-input` | `malformedInput` | something in the request could not be read |
 * | `insufficient-funds` | `insufficientFunds` | the wallet does not hold enough |
 * | `too-many-inputs` | `tooManyInputs` | it holds enough, spread too thin — consolidate |
 * | `not-ready` + shielded | `notReadyShielded` | **scan first**: the coins are not all counted yet |
 * | `not-ready` + unshielded | `notReadyUnshielded` | wait: the outputs are still being read |
 * | anything else | `unknown` | a generic failure; the log carries the detail |
 *
 * ⚠️ **`not-ready` splits by rail because the user's next action differs**, and that is the whole
 * reason this takes a rail at all. An unshielded wallet is *mid-replay* and finishes on its own; a
 * shielded one is **not scanning at all** — nothing syncs that rail in the background, so it sits
 * behind until someone taps Sync. Telling a shielded user to wait would be telling them to wait for
 * something that will never happen.
 *
 * @module
 */

import {type BuildFailureCause, MidnightBuildError} from './build-failure'
import type {MidnightTransferRail} from './build-transfer'

export type BuildFailureCopyKey =
  | 'invalidRecipient'
  | 'malformedInput'
  | 'insufficientFunds'
  | 'tooManyInputs'
  | 'notReadyShielded'
  | 'notReadyUnshielded'
  | 'unknown'

const keyForCause = (cause: BuildFailureCause, rail: MidnightTransferRail): BuildFailureCopyKey => {
  switch (cause) {
    case 'invalid-recipient':
      return 'invalidRecipient'
    case 'malformed-input':
      return 'malformedInput'
    case 'insufficient-funds':
      return 'insufficientFunds'
    case 'too-many-inputs':
      return 'tooManyInputs'
    case 'not-ready':
      return rail === 'shielded' ? 'notReadyShielded' : 'notReadyUnshielded'
  }
}

/**
 * ⚠️ **Anything that is not a `MidnightBuildError` is `unknown`, deliberately.** A native builder
 * rejects with a plain string — *"holds 0 of this token, need 500000"* — which is informative and is
 * also untranslated English written for a developer. It goes to the log, where it is useful, and the
 * user gets a sentence in their own language. Classifying those strings properly is a separate job:
 * they should be typed at the boundary that produces them, not pattern-matched here.
 */
export const buildFailureCopyKey = (error: unknown, rail: MidnightTransferRail): BuildFailureCopyKey =>
  error instanceof MidnightBuildError ? keyForCause(error.cause, rail) : 'unknown'
