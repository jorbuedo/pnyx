/**
 * Say what a submission failure actually was.
 *
 * ⚠️ **The node's reason is destroyed three times over, and this is the only place it can be caught.**
 * The wallet SDK wraps every node rejection in `new SubmissionError({message: 'Transaction submission
 * error', cause: err})` — a `Data.TaggedError`, so the truth is a *field*, not an `Error.cause`. Effect
 * then rejects the promise with a `FiberFailure` whose `message` is the summary alone, so a walk over
 * `.cause` finds nothing to unwrap. The sponsor records that summary; and when it answers 502,
 * Cloudflare replaces the body with its own "error code: 502" page, so the caller sees even less.
 *
 * The result was a handle claim that failed after ~100 s and two on-device proofs with no recoverable
 * reason anywhere: not in the app, not in the sponsor's status, not in its journal.
 *
 * `Cause.pretty` renders the whole failure, including the wrapped cause, which is what the SDK's
 * message leaves out.
 *
 * @module
 */

import {Cause, Runtime} from 'effect'

/** Everything we can say about `error`, cause chain included. Never throws; never returns empty. */
export const describeSubmitFailure = (error: unknown): string => {
  const parts: string[] = []
  const add = (message: string): void => {
    const trimmed = message.trim()
    if (trimmed !== '' && !parts.includes(trimmed)) parts.push(trimmed)
  }

  if (Runtime.isFiberFailure(error)) {
    const cause = error[Runtime.FiberFailureCauseId]
    try {
      // ⚠️ `Cause.pretty` renders the *wrapper* and its stack — "SubmissionError: Transaction
      // submission error" — and drops the field the node's reason is in. The failure value is where
      // to look.
      const failure = Cause.failureOption(cause)
      if (failure._tag === 'Some') {
        for (const message of walk(failure.value)) add(message)
      } else {
        add(firstLine(Cause.pretty(cause)))
      }
    } catch (renderError) {
      // Carried rather than logged: this is a pure function with no logger, and a reason that cannot
      // be rendered is itself part of the answer — swallowing it would leave the caller describing a
      // failure with no hint that a description was attempted and lost.
      add(
        `the cause could not be rendered: ${renderError instanceof Error ? renderError.message : String(renderError)}`,
      )
    }
  }

  for (const message of walk(error)) add(message)
  return parts.length === 0 ? String(error) : parts.join(' ← ')
}

/** Messages down a cause chain, following `Error.cause` and a `cause` carried as a plain field. */
function* walk(value: unknown): Generator<string> {
  const seen = new Set<unknown>()
  let current: unknown = value
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    yield current instanceof Error ? current.message : String(current)
    // A `Data.TaggedError` keeps its wrapped error as an own field rather than through `Error.cause`,
    // and it is not always an Error — an Effect cause, a response object and a bare string have all
    // turned up here.
    current = current instanceof Error && current.cause !== undefined ? current.cause : fieldCause(current)
  }
}

/** `cause` as a plain property, for errors that carry it as data rather than through `Error`. */
const fieldCause = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'cause' in value ? (value as {cause: unknown}).cause : undefined

/** A rendered cause is multi-line with a stack; only its first line says anything. */
const firstLine = (rendered: string): string => rendered.split('\n')[0] ?? rendered

/**
 * The error to throw when the node refuses a submission.
 *
 * ⚠️ **The message matters beyond reading it.** `isCoinContentionError` decides whether the submitter
 * resyncs and retries by looking for `1010` and `invalid transaction` *in the message* — and the error
 * the SDK hands us says only "Transaction submission error". So a stale-coin rejection, the exact
 * failure that retry exists for, was classified as fatal and thrown. Putting the described reason in
 * the message is what lets that machinery see it.
 */
export const submitRejectionError = (error: unknown): Error =>
  new Error(`submitProven: the node refused the transaction: ${describeSubmitFailure(error)}`, {cause: error})
