/**
 * Koios API bearer token store.
 *
 * An authenticated Koios tier (registered per stake account) lifts the public
 * rate limit (50k/day free tier vs the shared public bucket). The token is a
 * JWT with an `exp`; we persist it per network, expose a synchronous getter for
 * the provider (which needs `() => string | undefined`), and let the
 * registration flow write a fresh one. A build-time env token
 * (`EXPO_PUBLIC_CARDANO_KOIOS_TOKEN`) is the fallback for dev before per-identity
 * registration exists.
 *
 * @module
 */

import {cardanoKoiosToken} from '../../config/env'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'

const KEY = (network: string): string => `@pnyx/koios-token/${network}`

// Expo inlines `process.env.EXPO_PUBLIC_*` only for literal member expressions.
const ENV_TOKEN = typeof process === 'undefined' || !process?.env ? undefined : cardanoKoiosToken()

// Synchronous cache the provider getter reads. Populated from storage at init
// (`loadKoiosToken`) and updated by the registration flow (`setKoiosToken`).
const cache = new Map<string, string>()

/** Hydrate the in-memory cache from persisted storage (best-effort). Call once per network at init. */
export const loadKoiosToken = async (network: string): Promise<void> => {
  try {
    const stored = await storage.get(KEY(network))
    if (stored !== null && stored.length > 0) cache.set(network, stored)
  } catch (e: unknown) {
    // Non-fatal — the env fallback and re-registration cover it. But silently, this reads as
    // "no token stored" on every launch, which is a re-registration per launch and the rate
    // limit the token exists to lift.
    logger.warn('Koios token could not be read from storage; treating this network as unregistered', {
      origin: 'koios-token',
      network,
      error: String(e),
    })
  }
}

/** Persist + cache a freshly registered token. */
export const setKoiosToken = async (network: string, token: string): Promise<void> => {
  cache.set(network, token)
  try {
    await storage.set(KEY(network), token)
  } catch (e: unknown) {
    logger.warn('Koios token not persisted; this network re-registers on the next launch', {
      origin: 'koios-token',
      network,
      error: String(e),
    })
  }
}

/** Clear a token (e.g. after a 401 / expiry) so the next request re-registers. */
export const clearKoiosToken = async (network: string): Promise<void> => {
  cache.delete(network)
  try {
    await storage.remove(KEY(network))
  } catch (e: unknown) {
    // The in-memory cache is already cleared, so this launch re-registers either way — but the
    // dead token is still on disk and the next launch loads it back.
    logger.warn('Koios token not removed from storage; the next launch reloads the cleared token', {
      origin: 'koios-token',
      network,
      error: String(e),
    })
  }
}

/** The active token for a network: a registered/stored one wins over the env fallback. */
export const getKoiosToken = (network: string): string | undefined => cache.get(network) ?? ENV_TOKEN

/** Only the stored/registered token (no env fallback) — drives the "should we register?" decision. */
export const getStoredKoiosToken = (network: string): string | undefined => cache.get(network)

/** Decode a JWT's `exp` (unix seconds) without verifying — for local expiry checks. `null` if unparseable. */
export const koiosTokenExp = (token: string): number | null => {
  const part = token.split('.')[1]
  if (part === undefined) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const exp = (JSON.parse(json) as {exp?: unknown}).exp
    return typeof exp === 'number' ? exp : null
  } catch (e: unknown) {
    // ⚠️ `null` means "no expiry known", and `isKoiosTokenExpired` reads that as NOT expired —
    // so an undecodable token is used until the server rejects it. Worth seeing.
    logger.warn('Koios token payload could not be decoded; its expiry is unknown and it will be used as valid', {
      origin: 'koios-token',
      error: String(e),
    })
    return null
  }
}

/** True when the token is absent or within `skewSecs` of expiry (⇒ re-register). */
export const isKoiosTokenExpired = (token: string | undefined, nowMs: number, skewSecs = 86_400): boolean => {
  if (token === undefined) return true
  const exp = koiosTokenExp(token)
  return exp === null ? false : exp - skewSecs <= Math.floor(nowMs / 1000)
}
