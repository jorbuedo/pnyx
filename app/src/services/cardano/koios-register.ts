/**
 * Per-identity Koios tier registration.
 *
 * Each Pnyx identity self-registers with Koios for its own authenticated tier
 * (50k requests/day) instead of sharing the rate-limited public bucket. The
 * identity — Midnight-only until now — derives a CIP-1852 Cardano **stake**
 * account (used ONLY to sign the Koios verification, never for funds), signs
 * Koios's challenge with CIP-8/COSE `signData`, and POSTs to `/login/auth/register`
 * to obtain a JWT. The token is persisted via {@link setKoiosToken}; a slightly
 * stale JWT triggers a re-register on next launch.
 *
 * @module
 */

import {type AddressHex, XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Cose, Keys} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {identityStakeXprv} from '../identity-role-keys'
import {recordInfraSignature} from '../signing-audit'
import type {CardanoRailConfig} from './config'
import {getStoredKoiosToken, isKoiosTokenExpired, loadKoiosToken, setKoiosToken} from './koios-token'

const ORIGIN = 'KoiosRegister'
const PURPOSE = 'Koios Account Verification'
const TIER = 1 // free
const DURATION_DAYS = 365
const REGISTRATION_STAKE_ACCOUNT = 0 // identity's CIP-1852 account index for Koios auth

// One registration attempt per process — avoids re-hitting Koios on every rail build.
let attempted = false

const utf8ToHex = (s: string): string =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** `https://api.koios.rest/api/v1` → `https://api.koios.rest/login` (the auth surface). */
const authBaseOf = (koiosUrl: string): string => `${koiosUrl.replace(/\/api\/v[0-9]+\/?$/, '')}/login`

type Verification = {
  readonly rewardAddress: string
  readonly signature: string
  readonly key: string
}

type IdentityAccount = {
  readonly stakeKeyHashHex: string
  /** Branded, not a bare string: `Cose.signData` takes a `CoseAddressHeader`, and widening it
   *  here is how the brand introduced in `455c05f5` gets quietly undone. */
  readonly rewardHex: AddressHex
  readonly rewardAddress: string
}

/**
 * Derive the identity's Cardano stake account. Pure crypto over the identity seed — no network,
 * and deliberately NO signature: `/auth/check` only needs the address, and signing before we know
 * the endpoint is even there spent a COSE signature (and an audit row) on every launch against a
 * service that has been answering 404.
 */
const deriveAccount = (stakeXprvHex: string, networkId: number): Effect.Effect<IdentityAccount, unknown> =>
  Effect.gen(function* () {
    const stakeKeyHashHex = yield* Keys.keyHashOf(XprvHex(stakeXprvHex))
    const rewardHex = Address.rewardHex(networkId as Address.Network, stakeKeyHashHex)
    const rewardAddress = yield* Address.toBech32(rewardHex)
    return {stakeKeyHashHex, rewardHex, rewardAddress}
  })

/** Sign the Koios verification challenge. `nonce` is the caller's timestamp (server checks freshness). */
const signVerification = (
  stakeXprvHex: string,
  account: IdentityAccount,
  nonce: number,
): Effect.Effect<Verification, unknown> =>
  Effect.gen(function* () {
    // The signed message — `account` is the 29-byte reward-address hex (Koios's shape).
    const payloadHex = utf8ToHex(JSON.stringify({purpose: PURPOSE, account: account.rewardHex, nonce}))
    const sig = yield* Cose.signData(XprvHex(stakeXprvHex), account.rewardHex, payloadHex, false)
    void recordInfraSignature({
      purpose: 'koios-register',
      payloadHex,
      signer: account.rewardHex,
      signerKind: 'cardano-address-hex',
    })
    return {rewardAddress: account.rewardAddress, signature: sig.signature, key: sig.key}
  })

type PostResult = {readonly status: number; readonly json: unknown; readonly body: string}

/**
 * POST and read the body without assuming it is JSON.
 *
 * Koios's API gateway answers an unrouted path with an HTML page reading
 * `Query not Found! …`, so parsing unconditionally reported
 * `SyntaxError: Unexpected character: Q` — a symptom that names the letter Q where the fact is
 * a 404. The status and a snippet of what actually came back are what a reader needs.
 */
const postJson = async (url: string, body: unknown): Promise<PostResult> => {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: '*/*'},
    body: JSON.stringify(body),
  })
  const text = await r.text().catch((e: unknown) => {
    logger.warn('Koios response body could not be read', {origin: ORIGIN, status: r.status, error: String(e)})
    return ''
  })
  const read = readKoiosBody(r.headers.get('content-type'), text)
  if (read.malformed !== null) {
    logger.warn('Koios claimed a JSON body and did not send one', {
      origin: ORIGIN,
      status: r.status,
      body: read.body,
      error: read.malformed,
    })
  }
  return {status: r.status, json: read.json, body: read.body}
}

/**
 * Split a response body into "the JSON, if it is JSON" and "a snippet worth logging".
 *
 * Pure, and exported so it can be tested without a network: the bug this replaces was entirely
 * about misreading a body, and a test of that must not need `fetch`.
 */
export const readKoiosBody = (
  contentType: string | null,
  text: string,
): {readonly json: unknown; readonly body: string; readonly malformed: string | null} => {
  const body = text.slice(0, 160).replace(/\s+/g, ' ').trim()
  const claimsJson = (contentType ?? '').includes('json') || /^\s*[[{]/.test(text)
  if (!claimsJson) return {json: null, body, malformed: null}
  try {
    return {json: JSON.parse(text), body, malformed: null}
  } catch (e: unknown) {
    // Returned rather than logged: this function is pure so it can be tested without a network,
    // and the reason must still reach the caller's log instead of being swallowed here.
    return {json: null, body, malformed: String(e)}
  }
}

/**
 * Whether a recorded 404 still stands. Pure so the window can be tested without storage.
 *
 * An unparseable or absent marker means "we do not know", which must read as ASK rather than as
 * absence — a corrupt value should not mute registration forever.
 */
export const koiosAbsenceHolds = (markedAt: string | null, nowMs: number): boolean => {
  if (markedAt === null) return false
  const marked = Number(markedAt)
  return Number.isFinite(marked) && marked <= nowMs && nowMs - marked < ACCOUNT_API_ABSENT_MS
}

/**
 * How long to stay quiet after Koios's account API answers 404.
 *
 * It is not a rate-limit backoff — it is the cost of asking a question that currently has no
 * answerer. As of 2026-09-30 the whole `/login/*` family on `api.koios.rest` returns 404
 * (including `/login/util/price`, which Koios's own website calls) and `koios.rest` itself
 * answers 502, so registration cannot succeed for anyone. Without this, every launch spent a
 * vault read, a stake derivation and a round-trip to learn that again, and wrote two warnings
 * that read like a wallet defect.
 *
 * Twelve hours, not permanent: the API may come back, and a marker that never expires would
 * need a human to notice and clear it.
 */
const ACCOUNT_API_ABSENT_MS = 12 * 60 * 60_000

const ABSENT_KEY = (network: string): string => `@pnyx/koios-account-api-absent/${network}`

/** Remember that the account API is not there, and say so once with what it actually returned. */
const markAccountApiAbsent = async (network: string, nowMs: number, url: string, body: string): Promise<void> => {
  logger.warn('Koios account API is not available; staying on the public tier', {
    origin: ORIGIN,
    network,
    url,
    status: 404,
    body,
    retryAfterHours: ACCOUNT_API_ABSENT_MS / 3_600_000,
  })
  try {
    await storage.set(ABSENT_KEY(network), String(nowMs))
  } catch (e: unknown) {
    // Not fatal, but it means the next launch asks again and logs this again — worth seeing,
    // because the whole point of the marker is to stop that.
    logger.warn('Koios absence marker not persisted; the next launch will retry registration', {
      origin: ORIGIN,
      network,
      error: String(e),
    })
  }
}

const clearAccountApiAbsent = async (network: string): Promise<void> => {
  try {
    await storage.remove(ABSENT_KEY(network))
  } catch (e: unknown) {
    logger.debug('Koios absence marker not cleared; it expires on its own', {origin: ORIGIN, network, error: String(e)})
  }
}

/** True while a recent 404 says there is nothing to register against. */
const accountApiKnownAbsent = async (network: string, nowMs: number): Promise<boolean> => {
  try {
    return koiosAbsenceHolds(await storage.get(ABSENT_KEY(network)), nowMs)
  } catch (e: unknown) {
    // Reading failed, so we do not know — ask Koios rather than assume absence.
    logger.debug('Koios absence marker unreadable; attempting registration', {
      origin: ORIGIN,
      network,
      error: String(e),
    })
    return false
  }
}

/** A stable 16-char project id per identity (Koios ties one subscription per stake account). */
const projIdOf = (stakeKeyHashHex: string): string => stakeKeyHashHex.slice(0, 16)

/**
 * Register the identity's Cardano stake account with Koios and persist the JWT.
 * Returns the token, or `null` if any step fails (the caller keeps the env /
 * public fallback — registration is an optimization, never a hard dependency).
 */
export const registerKoiosToken = async (config: CardanoRailConfig, nowMs: number): Promise<string | null> => {
  const authBase = authBaseOf(config.koiosUrl)
  try {
    // The derived stake key, not the seed: the cache holds it for the session so a
    // token renewal doesn't re-read the vault (Phase 16 item 42).
    const stakeXprvHex = await identityStakeXprv(REGISTRATION_STAKE_ACCOUNT)
    const account = await Effect.runPromise(deriveAccount(stakeXprvHex, config.networkId))

    const check = await postJson(`${authBase}/auth/check`, {rewardAddress: account.rewardAddress})
    if (check.status === 404) {
      await markAccountApiAbsent(config.network, nowMs, `${authBase}/auth/check`, check.body)
      return null
    }
    const alreadyRegistered = (check.json as {success?: boolean} | null)?.success === true
    if (alreadyRegistered) {
      // Registered on a prior device/session but we have no local JWT — nothing
      // to re-issue without the original flow; fall back to public/env tier.
      logger.info('Koios account already registered elsewhere; using fallback tier', {origin: ORIGIN})
      return null
    }

    const v = await Effect.runPromise(signVerification(stakeXprvHex, account, nowMs))
    const reg = await postJson(`${authBase}/auth/register`, {
      verification: {rewardAddress: v.rewardAddress, signature: v.signature, key: v.key},
      projID: projIdOf(account.stakeKeyHashHex),
      tier: TIER,
      duration: DURATION_DAYS,
    })
    if (reg.status === 404) {
      await markAccountApiAbsent(config.network, nowMs, `${authBase}/auth/register`, reg.body)
      return null
    }
    const token = (reg.json as {data?: {token?: unknown}} | null)?.data?.token
    if (typeof token !== 'string' || token.length === 0) {
      logger.warn('Koios registration returned no token', {origin: ORIGIN, status: reg.status, body: reg.body})
      return null
    }
    await clearAccountApiAbsent(config.network)
    await setKoiosToken(config.network, token)
    logger.info('Registered identity with Koios authenticated tier', {origin: ORIGIN, network: config.network})
    return token
  } catch (e) {
    logger.warn('Koios registration failed (using fallback tier)', {origin: ORIGIN, error: String(e)})
    return null
  }
}

/**
 * Ensure an authenticated Koios token exists for the identity, best-effort and
 * at most once per process. Hydrates the stored token first; no-op when a valid
 * REGISTERED token is present (the env/public fallback deliberately does NOT
 * count — each identity should hold its own). Registers when absent or near
 * expiry. Fire-and-forget from rail setup — a failure leaves the fallback in place.
 */
export const ensureKoiosToken = (config: CardanoRailConfig, nowMs: number): void => {
  if (attempted) return
  attempted = true
  void (async () => {
    await loadKoiosToken(config.network)
    const stored = getStoredKoiosToken(config.network)
    if (stored !== undefined && !isKoiosTokenExpired(stored, nowMs)) return
    if (await accountApiKnownAbsent(config.network, nowMs)) {
      logger.debug('Koios account API was absent recently; not retrying this launch', {
        origin: ORIGIN,
        network: config.network,
      })
      return
    }
    await registerKoiosToken(config, nowMs)
  })()
}
