/**
 * CIP-171 script provenance: does a published source repository compile to the
 * script hash this transaction is about to run?
 *
 * CIP-171 puts that claim on chain under metadata label 1984 and anyone may
 * verify it by rebuilding the source. We do not rebuild anything on a phone —
 * we ask a registry that already did, and report what it says. Three outcomes,
 * kept distinct on purpose:
 *
 *  - `verified` — the registry holds a VERIFIED record whose script list
 *    contains this exact hash. The review may show the source it came from.
 *  - `unverified` — the registry answered and has no such record. A fact.
 *  - `unknown` — nobody was asked (no registry configured) or the ask failed.
 *    NOT a fact about the contract, and never rendered as one.
 *
 * The registry is trusted only for what it is: a claim that someone rebuilt the
 * source and got this hash. It cannot make an unverified contract safe, and a
 * verified one can still be malicious — the badge says "this is the code", not
 * "this code is good".
 *
 * @module
 */

import {cardanoScriptVerificationUrl} from '../../config/env'
import {logger} from '../../logger'

/** What the registry says about one script hash. */
export type ScriptVerification =
  | {
      readonly status: 'verified'
      readonly sourceUrl: string
      readonly commitHash: string
      /** Path to the project within the repository; empty means the root. */
      readonly sourcePath: string
      /** `AIKEN`, `PLUTARCH`, … as the registry reports it. */
      readonly compilerType: string
      readonly compilerVersion: string
      /** The Aiken `--env` module the build used; null when built without one. */
      readonly env: string | null
      /** The transaction that published the record. */
      readonly txHash: string
    }
  | {readonly status: 'unverified'}
  | {readonly status: 'unknown'; readonly reason: string}

/** The registry's `ScriptListResponseDto`, narrowed to the fields we read. */
type RegistryResponse = {
  readonly txHash?: unknown
  readonly sourceUrl?: unknown
  readonly commitHash?: unknown
  readonly sourcePath?: unknown
  readonly compilerType?: unknown
  readonly compilerVersion?: unknown
  readonly env?: unknown
  readonly status?: unknown
  readonly scripts?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/**
 * Turn a registry response into a verdict for `hashHex`.
 *
 * Two checks, and both matter. The record must say `VERIFIED` — the registry
 * also stores PENDING and FAILED attempts, and a failed rebuild is the opposite
 * of provenance. And the record's own script list must contain the hash we
 * asked about, either as the `rawHash` (the unapplied validator) or as the
 * `finalHash` (a parameterized instance): the endpoint is keyed by hash, but
 * confirming the answer against the question is what keeps a future indexing
 * change from turning into a badge on the wrong contract.
 */
export const verdictFromRegistry = (hashHex: string, body: unknown): ScriptVerification => {
  if (body === null || typeof body !== 'object') return {status: 'unverified'}
  const r = body as RegistryResponse
  if (r.status !== 'VERIFIED') return {status: 'unverified'}
  const wanted = hashHex.toLowerCase()
  const scripts = Array.isArray(r.scripts) ? r.scripts : []
  const matched = scripts.some((s) => {
    if (s === null || typeof s !== 'object') return false
    const entry = s as {readonly rawHash?: unknown; readonly finalHash?: unknown}
    return str(entry.rawHash)?.toLowerCase() === wanted || str(entry.finalHash)?.toLowerCase() === wanted
  })
  if (!matched) return {status: 'unverified'}
  const sourceUrl = str(r.sourceUrl)
  const commitHash = str(r.commitHash)
  const compilerType = str(r.compilerType)
  const compilerVersion = str(r.compilerVersion)
  // A VERIFIED record without a source and a commit describes nothing a reader
  // could check, so it is not something to put a check mark next to.
  if (
    sourceUrl === undefined ||
    commitHash === undefined ||
    compilerType === undefined ||
    compilerVersion === undefined
  ) {
    return {status: 'unverified'}
  }
  return {
    status: 'verified',
    sourceUrl,
    commitHash,
    sourcePath: typeof r.sourcePath === 'string' ? r.sourcePath : '',
    compilerType,
    compilerVersion,
    env: typeof r.env === 'string' && r.env.length > 0 ? r.env : null,
    txHash: str(r.txHash) ?? '',
  }
}

// A record is published once and never edited, so a hit is stable; a miss only
// becomes a hit when somebody registers the script, which is not a thing that
// happens while a review sheet is open. Neither TTL needs to be short, and
// `unknown` is never cached — a failed ask must be retried, not remembered.
const POSITIVE_TTL_MS = 24 * 60 * 60_000
const NEGATIVE_TTL_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 6_000

type CacheEntry = {readonly value: ScriptVerification; readonly at: number}
const cache = new Map<string, CacheEntry>()

const fresh = (entry: CacheEntry, nowMs: number): boolean =>
  nowMs - entry.at < (entry.value.status === 'verified' ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)

/** Clear the verdict cache (tests, and a registry-URL change). */
export const clearScriptVerificationCache = (): void => {
  cache.clear()
}

/**
 * Ask the configured registry about one script hash.
 *
 * `baseUrl` defaults to the configured registry; absent means the feature is off
 * and every hash is `unknown` without a request being made.
 */
export const fetchScriptVerification = async (
  hashHex: string,
  options: {readonly baseUrl?: string | undefined; readonly signal?: AbortSignal} = {},
): Promise<ScriptVerification> => {
  const baseUrl = options.baseUrl ?? cardanoScriptVerificationUrl()
  if (baseUrl === undefined) {
    logger.debug('script-verification: no registry configured, skipping lookup', {hash: hashHex})
    return {status: 'unknown', reason: 'no-registry-configured'}
  }
  const hash = hashHex.toLowerCase()
  const key = `${baseUrl}:${hash}`
  const hit = cache.get(key)
  if (hit !== undefined && fresh(hit, Date.now())) return hit.value

  // Hermes has neither `AbortSignal.timeout` nor `AbortSignal.any`, so the deadline is a
  // controller by hand — same shape as `pnyx-session.ts`. Reaching for the statics threw
  // before the request was ever made, which turned every verdict into `unknown` on device.
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort()
  if (options.signal?.aborted === true) controller.abort()
  else options.signal?.addEventListener('abort', abortFromCaller)
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/scripts/by-hash/${hash}`, {
      headers: {accept: 'application/json'},
      signal: controller.signal,
    })
    // 404 is the registry's "no record", which is an answer, not a failure.
    if (res.status === 404) {
      const value: ScriptVerification = {status: 'unverified'}
      cache.set(key, {value, at: Date.now()})
      logger.debug('script-verification: registry has no record', {hash})
      return value
    }
    if (!res.ok) {
      logger.warn('script-verification: registry lookup failed', {hash, status: res.status})
      return {status: 'unknown', reason: `http-${res.status}`}
    }
    const value = verdictFromRegistry(hash, await res.json())
    cache.set(key, {value, at: Date.now()})
    logger.debug('script-verification: registry answered', {hash, status: value.status})
    return value
  } catch (e) {
    logger.warn('script-verification: registry lookup threw', {hash, error: String(e)})
    return {status: 'unknown', reason: e instanceof Error ? e.message : String(e)}
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/**
 * Ask about several hashes at once. Each answer stands alone: one failing
 * lookup leaves that hash `unknown` and says nothing about the others.
 */
export const fetchScriptVerifications = async (
  hashes: readonly string[],
  options: {readonly baseUrl?: string | undefined; readonly signal?: AbortSignal} = {},
): Promise<ReadonlyMap<string, ScriptVerification>> => {
  const entries = await Promise.all(
    hashes.map(async (hash) => [hash.toLowerCase(), await fetchScriptVerification(hash, options)] as const),
  )
  return new Map(entries)
}
