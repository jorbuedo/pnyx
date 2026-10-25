/**
 * The lock configuration — device-global, never profile-scoped.
 *
 * This record has to be readable **above** the profile gate, before a profile
 * exists, because it is what decides which profile to open. That means the
 * decoy can reach it too, so nothing that renders it may show more than the
 * active profile's own entry (see `docs/DISTRESS_PROFILE_PLAN.md`).
 *
 * Codes are stored as Argon2id verifiers with a per-code salt — never
 * plaintext, never reversible. Resolving a typed code is a linear scan of the
 * verifiers; there is no "which code is this" shortcut, and there must not be.
 *
 * @module
 */

import {hex, randomBytes, sha256, utf8} from '@pnyx/crypto'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {deviceStorage} from '../../platform/storage'
import type {CodeKind} from './pin-outcome'
import {type PinMode, parsePinMode} from './pin-required'

const CONFIG_KEY = '@pnyx/lock-config'
const ARMED_KEY = '@pnyx/lock-armed'

const CONFIG_VERSION = 2

/**
 * Domain tag, so a stored hash can only ever be interpreted as a lock code.
 */
const DOMAIN = 'pnyx:lock:v2'

/**
 * Codes are stored as a **salted SHA-256**, deliberately not a memory-hard KDF.
 *
 * What this buys: reading the config off disk does not hand over the codes.
 *
 * What it does not buy, and is not meant to: resistance to offline brute force.
 * A 6-digit PIN is a 10^6 space — no KDF makes that meaningfully hard, and the
 * threat model here is someone standing over your shoulder, not someone imaging
 * the device (`docs/DISTRESS_PROFILE_PLAN.md`). The seeds are protected by the
 * enclave regardless of this value; the PIN only selects a namespace.
 *
 * The first cut used Argon2id at 19 MiB. On Hermes it did not merely run slowly
 * — it never returned, and the PIN screen hung on every entry. Cost that buys
 * nothing against the stated threat is not worth one frozen frame, let alone a
 * hang.
 */
const deriveHash = (code: string, saltHex: string): string =>
  hex.encode(sha256(utf8.encode(`${DOMAIN}:${saltHex}:${code}`)))

type StoredVerifier = {
  readonly kind: CodeKind
  readonly hash: string
  /**
   * Digit count. Stored because the wipe-code rule — it must differ in length
   * from every profile PIN, so no typo of a PIN can reach an irreversible
   * action — cannot be checked against a one-way verifier. Within the stated
   * threat model (storage forensics is out of scope) a length is not a
   * meaningful disclosure; the alternative is dropping the rule.
   */
  readonly length: number
}

export type {StoredVerifier}

export type LockConfig = {
  readonly version: typeof CONFIG_VERSION
  readonly mode: PinMode
  /**
   * One salt for the whole config, not one per code. That makes resolving an
   * attempt exactly **one** hash regardless of how many codes exist — and
   * therefore constant-time across codes by construction, with no per-verifier
   * loop whose duration could reveal which slot matched.
   */
  readonly salt: string
  readonly verifiers: readonly StoredVerifier[]
}

const isVerifier = (v: unknown): v is StoredVerifier => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<StoredVerifier>
  return (
    (r.kind === 'real' || r.kind === 'decoy' || r.kind === 'wipe') &&
    typeof r.hash === 'string' &&
    typeof r.length === 'number'
  )
}

/**
 * Parse a stored config. A malformed record reads as **no lock** rather than as
 * a broken one: refusing to boot because a settings blob got corrupted would
 * strand the user out of their wallet, and the gate failing open only costs the
 * PIN, never the seed (which stays enclave-gated regardless).
 */
export const parseLockConfig = (raw: string | null): LockConfig | undefined => {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Partial<LockConfig>
    if (value.version !== CONFIG_VERSION) return undefined
    if (typeof value.salt !== 'string') return undefined
    const mode = parsePinMode(value.mode)
    if (mode === undefined) return undefined
    if (!Array.isArray(value.verifiers) || !value.verifiers.every(isVerifier)) return undefined
    // At least one code must open something. Deliberately not "must contain a
    // real verifier": after a duress wipe the only surviving code is the
    // decoy's, and the gate has to keep honouring it.
    if (value.verifiers.length === 0) return undefined
    return {version: CONFIG_VERSION, mode, salt: value.salt, verifiers: value.verifiers}
  } catch (e: unknown) {
    // ⚠️ `undefined` reads as "no PIN configured", which is the same answer as a device that
    // never set one — on the gate that selects the profile namespace.
    logger.warn('PIN config could not be read; treating it as unconfigured', {
      origin: 'profile/pin-config',
      error: String(e),
    })
    return undefined
  }
}

/** Synchronous read — the gate needs this before first paint. */
export const readLockConfigSync = (): LockConfig | undefined => parseLockConfig(deviceStorage.getSync(CONFIG_KEY))

export const readLockConfig = async (): Promise<LockConfig | undefined> =>
  parseLockConfig(await deviceStorage.get(CONFIG_KEY))

/**
 * In-process change signal for the lock config.
 *
 * `deviceStorage` (MMKV) does not notify React, so a component that reads the
 * config once at mount — every tab's `AppTopBar`, each a separate instance kept
 * alive by the navigator — never learns the PIN was just set or cleared. The
 * writers below fire this so those readers can re-read via `useSyncExternalStore`.
 */
const configListeners = new Set<() => void>()

export const subscribeLockConfig = (listener: () => void): (() => void) => {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}

const notifyLockConfigChanged = (): void => {
  for (const listener of configListeners) listener()
}

export const writeLockConfig = async (config: LockConfig): Promise<void> => {
  await deviceStorage.set(CONFIG_KEY, JSON.stringify(config))
  notifyLockConfigChanged()
}

export const clearLockConfig = async (): Promise<void> => {
  await deviceStorage.remove(CONFIG_KEY)
  await deviceStorage.remove(ARMED_KEY)
  notifyLockConfigChanged()
}

/** A fresh config salt. */
export const newSalt = async (): Promise<string> => hex.encode(await Effect.runPromise(randomBytes(16)))

/**
 * Build a stored verifier for `code` under the config's salt.
 *
 * The code is taken as raw UTF-8 with no trimming or normalisation, matching
 * the repo-wide password rule: whitespace is content, and silently altering it
 * here would lock a user out of a code they typed correctly.
 */
export const makeVerifier = (kind: CodeKind, code: string, salt: string): StoredVerifier => ({
  kind,
  hash: deriveHash(code, salt),
  length: code.length,
})

/**
 * Which configured code — if any — the typed digits match.
 *
 * One hash, then a lookup: the work does not depend on which code was typed, or
 * on how many are configured. A wrong code returns `undefined` and the caller
 * shows an error; it never falls through to opening some other profile.
 */
export const resolveCode = (config: LockConfig, code: string): CodeKind | undefined => {
  const candidate = deriveHash(code, config.salt)
  return config.verifiers.find((v) => v.hash === candidate)?.kind
}

/** True when a decoy code is configured. Read only from the real profile's UI. */
export const hasDecoy = (config: LockConfig | undefined): boolean =>
  config?.verifiers.some((v) => v.kind === 'decoy') ?? false

/** True when a wipe code is configured. Read only from the real profile's UI. */
export const hasWipeCode = (config: LockConfig | undefined): boolean =>
  config?.verifiers.some((v) => v.kind === 'wipe') ?? false

/** The armed flag — persisted, because it must survive a force-quit. */
export const isArmedSync = (): boolean => deviceStorage.getSync(ARMED_KEY) === '1'

export const setArmed = async (armed: boolean): Promise<void> => {
  if (armed) await deviceStorage.set(ARMED_KEY, '1')
  else await deviceStorage.remove(ARMED_KEY)
}
