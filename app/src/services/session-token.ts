/**
 * How long a session token lives, and when to replace it.
 *
 * Pure and offline: the JWT is ours, its claims are public, and reading `iat`/`exp` needs no
 * verification — the service verifies its own tokens and is the only party that ever does. Nothing
 * here trusts the claims for *authority*; they decide scheduling and nothing else, so a forged token
 * buys an attacker a badly-timed refresh.
 *
 * ⚠️ **Scheduling is a duration, never a deadline.** `exp - now` compares a server clock to the
 * device's, and a phone an hour out then either refreshes in a loop or never refreshes at all. The
 * token's own `exp - iat` is two server-clock readings, so the *lifetime* is skew-free — and measured
 * from the moment we received the token, a delay needs no absolute time at all.
 *
 * @module
 */

import {base64, utf8} from '@pnyx/crypto'
import {Either} from 'effect'
import {logger} from '../logger'

const ORIGIN = 'session-token'

/** Replace the token this long before it lapses, so a slow refresh still lands inside the old one. */
const REFRESH_MARGIN_SECS = 600

/**
 * Never schedule a refresh sooner than this.
 *
 * A floor against spinning on nonsense claims, not a correctness guarantee: a token whose whole life
 * is shorter than this cannot be replaced ahead of time, and the 401 path is what covers it.
 */
const MIN_REFRESH_DELAY_MS = 30_000

export type TokenLifetime = {
  /** `iat`, in unix seconds, on the *issuer's* clock. */
  readonly issuedAtSecs: number
  /** `exp`, in unix seconds, on the same clock. */
  readonly expiresAtSecs: number
}

/**
 * The `iat`/`exp` pair from a JWT, or `undefined` when it does not carry both.
 *
 * Absence is preserved rather than defaulted: a token whose lifetime cannot be read is refreshed
 * reactively on the first refusal, which is strictly better than inventing an hour and being wrong.
 */
export const readTokenLifetime = (token: string): TokenLifetime | undefined => {
  const lifetime = parseLifetime(token)
  if (typeof lifetime === 'string') {
    // ⚠️ Never silent. Every branch below returns the same `undefined`, and the consequence — no
    // proactive refresh, so the session lapses and something downstream meets a 401 — is invisible
    // from the outside. Which branch it was is the whole difference between a truncated token and a
    // service that changed its claims.
    logger.warn('a session token did not state its lifetime, so it will only be refreshed on refusal', {
      origin: ORIGIN,
      reason: lifetime,
    })
    return undefined
  }
  return lifetime
}

/** The lifetime, or the reason there is none. Split out so the caller logs in exactly one place. */
const parseLifetime = (token: string): TokenLifetime | string => {
  const segments = token.split('.')
  if (segments.length !== 3) return 'not three segments'
  const payload = segments[1]
  if (payload === undefined) return 'no payload segment'
  const bytes = base64.decode(payload)
  if (Either.isLeft(bytes)) return 'payload is not base64'
  const text = utf8.decode(bytes.right)
  if (Either.isLeft(text)) return 'payload is not utf8'
  let claims: unknown
  try {
    claims = JSON.parse(text.right)
  } catch (error) {
    return `payload is not json: ${String(error)}`
  }
  if (typeof claims !== 'object' || claims === null) return 'claims are not an object'
  const {iat, exp} = claims as {iat?: unknown; exp?: unknown}
  if (typeof iat !== 'number' || typeof exp !== 'number') return 'iat or exp is missing'
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return 'iat or exp is not finite'
  return {issuedAtSecs: iat, expiresAtSecs: exp}
}

/**
 * How long after receiving a token to replace it, in milliseconds.
 *
 * The margin is capped at half the token's life so a short-lived one still refreshes at its midpoint
 * rather than in the past — the fixed 10 minutes is tuned for the hour the service issues today, and
 * must not become a hidden assumption that the hour never changes.
 */
export const refreshDelayMs = (lifetime: TokenLifetime): number => {
  const span = lifetime.expiresAtSecs - lifetime.issuedAtSecs
  // Claims that disagree about the direction of time say nothing useful; try again later rather than
  // immediately, which is the one answer that could spin.
  if (span <= 0) return MIN_REFRESH_DELAY_MS
  const margin = Math.min(REFRESH_MARGIN_SECS, span / 2)
  return Math.max(MIN_REFRESH_DELAY_MS, (span - margin) * 1000)
}
