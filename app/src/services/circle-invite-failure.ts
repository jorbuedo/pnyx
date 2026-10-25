/**
 * Turn a refused invite claim into the answer to give the user.
 *
 * Its own pure module so it can be tested without a network or a stake key — the rest of
 * `circle-invite-request.ts` needs both. The mapping is the part worth pinning: the service
 * answers with three different statuses precisely so three different things can be said, and a
 * version that flattened them would still render *a* message on every branch, which is what makes
 * that kind of regression invisible.
 *
 * @module
 */

import {PnyxApiError} from './pnyx-api'

/** Why a request did not produce an invite. Each maps to its own message — they ask different things. */
export type InviteRequestFailure =
  /**
   * The wallet was read and meets none of the rules.
   *
   * ⚠️ **One reason per rule, in the circle's rule order** — the service sends them in full
   * precisely because with several rules "you do not qualify" is not an answer; the answer is which
   * of the several things to go and do. `reason` stays as the first, for the single-rule case and
   * for the log.
   */
  | {readonly kind: 'not-eligible'; readonly reason: string; readonly reasons: readonly string[]}
  /**
   * The circle cannot issue one. Its founder can fix this; the requester cannot.
   *
   * ⚠️ **No longer "the pool is empty"** — nothing is stocked ahead of time since 2026-09-10. The
   * `409` now means the founder has not delegated issuance, has withdrawn it, has set no
   * requirements, or the circle has no contract yet. All four are the founder's to finish, which is
   * the only distinction this status has ever carried; the service's `failure` code says which.
   */
  | {readonly kind: 'none-left'}
  /** We could not reach the chain to check. Retryable, and NOT a verdict about the wallet. */
  | {readonly kind: 'unavailable'}
  /** This circle does not offer self-service invites at all. */
  | {readonly kind: 'no-policy'}
  | {readonly kind: 'failed'; readonly message: string}

export const inviteFailureFrom = (error: unknown): InviteRequestFailure => {
  if (!(error instanceof PnyxApiError)) {
    return {kind: 'failed', message: String(error)}
  }
  switch (error.status) {
    // ⚠️ Our outage, never a verdict. Telling someone they do not qualify because Koios refused
    // us is the distinction the service's ok/error split exists to preserve; losing it here would
    // throw that away one layer later.
    case 503:
      return {kind: 'unavailable'}
    // They qualified — the circle is not set up to issue, which only its founder can fix.
    case 409:
      return {kind: 'none-left'}
    case 404:
      return {kind: 'no-policy'}
    case 403: {
      const body = error.body as {failure?: unknown; failures?: unknown} | undefined
      const failure = typeof body?.failure === 'string' ? body.failure : 'unknown'
      // ⚠️ A service older than this build sends only `failure`, so the list falls back to it rather
      // than to empty — an empty list would render a refusal with no reason at all.
      const listed = Array.isArray(body?.failures)
        ? body.failures.filter((one): one is string => typeof one === 'string')
        : []
      return {kind: 'not-eligible', reason: failure, reasons: listed.length > 0 ? listed : [failure]}
    }
    default:
      return {kind: 'failed', message: error.message}
  }
}
