/**
 * Reading the reason out of a failed Effect.
 *
 * ⚠️ **Never `await Effect.runPromise(...)` inside a `try`/`catch` to find out why something
 * failed.** A rejected `runPromise` throws a `FiberFailure` whose message is a rendered summary,
 * so the typed error the Effect actually failed with — the field that says *which* thing went
 * wrong — is gone by the time the `catch` sees it. Use `runPromiseExit` and bring the cause here.
 *
 * @module
 */

import {Cause, Option} from 'effect'

export type EffectFailure = {
  /** The typed error's `kind`, when it carries one. `null` for a defect or an untagged failure. */
  readonly kind: string | null
  /** Its `reason`, or the pretty-printed cause — never empty, so a log line is never blank. */
  readonly reason: string
}

/** The typed failure behind a cause, falling back to the pretty-printed cause for a defect. */
export const failureOf = (cause: Cause.Cause<unknown>): EffectFailure => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  const has = (key: string): boolean =>
    failure !== undefined && typeof failure === 'object' && failure !== null && key in failure
  return {
    kind: has('kind') ? String((failure as {kind: unknown}).kind) : null,
    reason: has('reason') ? String((failure as {reason: unknown}).reason) : Cause.pretty(cause),
  }
}

/** What a `catch` caught, as a string worth logging. `Error` keeps its message; anything else is stringified. */
export const reasonOfThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * The reason of a typed error **in hand** — what an `Effect.catchAll` handler receives.
 *
 * ⚠️ **`String(e)` on a `Data.TaggedError` renders only the tag.** So a log line reading
 * `error: "SteelswapError"` says nothing at all, and that is not hypothetical: every chart on a wallet
 * holding 54 tokens rendered empty and the log for it named the tag and dropped the reason, which is the
 * one field that would have said whether it was a rate limit, a quota, or a bad request.
 */
export const reasonOfFailure = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'reason' in error
    ? String((error as {reason: unknown}).reason)
    : reasonOfThrown(error)
