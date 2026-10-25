/**
 * Whether a session token found on disk may still be used.
 *
 * A cold start used to have nothing: the JWT lived in memory only, so reopening the app showed the
 * sign-in card even though the token it had minted twenty minutes earlier was still valid. The token
 * is persisted now ({@link ./session-store}), and this decides what a stored one is worth.
 *
 * ⚠️ **A restored session cannot be refreshed.** `refreshSessionToken` signs a fresh challenge with
 * `authPriv`, two HKDFs from `forumRoot` — which is seed-derived and deliberately never persisted,
 * because the whole point of the enclave is that the seed is not on disk. So the only thing a
 * restored token can do is be used until it is too old, and "too old" is what this answers. Asking
 * for more would mean an OS biometric prompt, which is the thing a silent restore exists to avoid.
 *
 * | age of the stored token | lifetime readable | decision | why |
 * |---|---|---|---|
 * | negative | either | `discard` | the device clock moved under us; an age we cannot read is not an age |
 * | at or past `exp - iat` | yes | `discard` | certainly spent, whatever the clocks say |
 * | at or past {@link MAX_RESTORE_AGE_MS} | either | `discard` | a token nobody can refresh must not be ridden to its expiry |
 * | anything less | either | `use` | |
 *
 * ⚠️ **Both readings are the device's own clock** — the moment the token arrived, and now. The
 * token's `exp` is on the *server's*, so it is only ever compared against its own `iat`
 * (`./session-token`). A phone an hour out of step is still right about how long it has had
 * something.
 *
 * @module
 */

import type {TokenLifetime} from './session-token'

/**
 * How old a stored token may be and still be used, in milliseconds.
 *
 * Half the hour the service issues today. The service's token outlives this on purpose: the margin
 * is what stops a restored session from being spent right up to a 401 that nothing can recover from
 * without asking the user. A session that is *running* keeps the proactive refresh instead, which is
 * a different mechanism with a different bound (`./session-token`).
 */
export const MAX_RESTORE_AGE_MS = 30 * 60 * 1000

export type RestoreDecision =
  /** Still fresh enough to carry a cold start. */
  | 'use'
  /** Drop it and show the sign-in card. Never silently keep a token this says no to. */
  | 'discard'

export const restoreDecision = (params: {
  readonly ageMs: number
  /** From the token's own claims, or `undefined` when it did not state them. */
  readonly lifetime: TokenLifetime | undefined
}): RestoreDecision => {
  if (!Number.isFinite(params.ageMs) || params.ageMs < 0) return 'discard'
  const lifetime = params.lifetime
  if (lifetime !== undefined) {
    const spanMs = (lifetime.expiresAtSecs - lifetime.issuedAtSecs) * 1000
    // A span that is zero or backwards says nothing about expiry, so it falls through to the age
    // bound below rather than discarding on arithmetic nobody can trust.
    if (spanMs > 0 && params.ageMs >= spanMs) return 'discard'
  }
  return params.ageMs >= MAX_RESTORE_AGE_MS ? 'discard' : 'use'
}
