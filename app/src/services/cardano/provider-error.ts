/**
 * Reading an Evolution `ProviderError` as one line.
 *
 * Their error splits what went wrong across two fields: `message` is a summary naming
 * the member, and `cause` carries the thing that actually failed. A log line or a toast
 * built from `message` alone therefore reports "getTxInfo failed" and discards the HTTP
 * status, the parse position, or the refusal body that says why. `cause` can itself nest,
 * so the innermost explanation is the one taken.
 *
 * @module
 */

/** The innermost explanation inside a thrown value, or `undefined` when there is none. */
const innermost = (cause: unknown): string | undefined => {
  if (cause === undefined || cause === null) return undefined
  const inner = typeof cause === 'object' && 'cause' in cause ? (cause as {readonly cause: unknown}).cause : undefined
  if (inner !== undefined && inner !== null) {
    const deeper = innermost(inner)
    if (deeper !== undefined) return deeper
  }
  const text = cause instanceof Error ? cause.message : String(cause)
  // `String(undefined)` is the string "undefined", which reads as a real explanation.
  return text === '' || text === 'undefined' ? undefined : text
}

/**
 * `message`, plus the real reason in parentheses when `cause` carries one.
 *
 * Both halves are kept rather than one chosen: the summary names the member that failed,
 * which the cause usually does not, and the cause names the failure, which the summary
 * never does.
 */
export const providerErrorText = (error: {readonly message: string; readonly cause?: unknown}): string => {
  const detail = innermost(error.cause)
  return detail === undefined || detail === error.message ? error.message : `${error.message} (${detail})`
}
