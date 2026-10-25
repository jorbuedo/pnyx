/**
 * Classifies a Cardano plan-build failure into the kinds the send/staking flows
 * report to the user.
 *
 * `@evolution-sdk/plan`'s builders throw tagged errors
 * (`InsufficientError`, `ExcessiveFeeFoldError`, `InvalidParamsError`), while a
 * caller that wraps a build in `Effect.try` flattens every cause into its own
 * error — the tag is lost there, so callers that want to tell these apart must
 * classify the thrown value here before wrapping it.
 *
 * Discrimination is by `_tag` string rather than `instanceof`: a package can
 * resolve to its built `dist` in the app and to source in a test, and two module
 * copies would defeat prototype checks.
 *
 * @module
 */

/** Why a build failed, in terms the UI has copy for. */
export type BuildFailureKind =
  | 'insufficient-funds'
  /**
   * The protocol parameters are structurally invalid, or the balancer refused to
   * fold an implausible amount of change into the fee. Both mean the params the
   * build ran against cannot be trusted — not that the user did anything wrong.
   */
  | 'unsafe-params'
  /**
   * The converged transaction is over the protocol's `maxTxSize`. Distinct from
   * `build-failed` because it is *actionable*: the same intent may fit once split
   * across chained transactions.
   */
  | 'too-large'
  /**
   * A single output's serialized value is over `maxValueSize`. A different
   * failure from `too-large` with a different remedy: the assets must move to
   * another *output*, not another transaction.
   */
  | 'value-too-large'
  | 'build-failed'

export type BuildFailure = {
  readonly kind: BuildFailureKind
  /** The underlying message, for logs — never rendered for `unsafe-params`. */
  readonly reason: string
}

const tagOf = (err: unknown): string | undefined => {
  if (typeof err !== 'object' || err === null || !('_tag' in err)) return undefined
  const tag = (err as {_tag: unknown})._tag
  return typeof tag === 'string' ? tag : undefined
}

/**
 * `reason` comes first: `BuildError` is an Effect `Data.TaggedError`, so it *is* an
 * `Error` but carries an empty `message` — reading that would discard the only
 * description of the failure.
 */
const messageOf = (err: unknown): string => {
  if (typeof err === 'object' && err !== null && 'reason' in err) {
    const reason = (err as {reason: unknown}).reason
    if (typeof reason === 'string') return reason
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * A `BuildError` has already lost its cause's tag, so fall back to the message.
 * Only `InsufficientError` is worth recovering this way — its text is stable and
 * the alternative is telling a user with too little ADA that something is broken.
 */
const classifyFlattened = (reason: string): BuildFailureKind =>
  reason.includes('insufficient') ? 'insufficient-funds' : 'build-failed'

/** Map a thrown build failure onto a UI-facing kind. */
export const classifyBuildFailure = (err: unknown): BuildFailure => {
  const reason = messageOf(err)
  switch (tagOf(err)) {
    case 'InsufficientError':
      return {kind: 'insufficient-funds', reason}
    case 'TxTooLargeError':
      return {kind: 'too-large', reason}
    case 'ValueTooLargeError':
      return {kind: 'value-too-large', reason}
    case 'ExcessiveFeeFoldError':
    case 'InvalidParamsError':
      return {kind: 'unsafe-params', reason}
    case 'BuildError':
      return {kind: classifyFlattened(reason), reason}
    default:
      return {kind: 'build-failed', reason}
  }
}
