/**
 * Mutating the lock configuration.
 *
 * Every entry point here is biometric-gated via {@link requireLockGateAuth} —
 * a keystore retrieval, not a JS boolean — and refuses rather than proceeding
 * when that gate is not satisfied.
 *
 * Reads are filtered by the calling profile. The configuration is device-global
 * (the gate has to read it before a profile exists), so the decoy *can* see all
 * three verifiers; {@link visibleLockSettings} is what stops the settings screen
 * from rendering them and announcing the real profile's existence.
 *
 * @module
 */

import {getActiveProfile} from './active-profile'
import {clearDecoySetupPending, markBootIntoDecoy, markDecoySetupPending} from './decoy-setup'
import {clearLockGateSentinel, ensureLockGateSentinel, requireLockGateAuth} from './lock-gate'
import {
  clearLockConfig,
  hasDecoy,
  hasWipeCode,
  type LockConfig,
  makeVerifier,
  newSalt,
  readLockConfig,
  writeLockConfig,
} from './pin-config'
import type {CodeKind} from './pin-outcome'
import type {PinMode} from './pin-required'
import {DEFAULT_PROFILE_ID} from './profile-id'

export type LockMutationResult =
  | {readonly ok: true}
  | {readonly ok: false; readonly reason: 'auth' | 'duplicate' | 'not-configured'}

/** What the Security screen may show, given which profile is open. */
export type VisibleLockSettings = {
  readonly configured: boolean
  readonly mode: PinMode | undefined
  /** Whether the decoy section renders at all. False in the decoy, always. */
  readonly canManageDecoy: boolean
  /** Whether "turn off PIN" is offered. False in the decoy, always. */
  readonly canDisable: boolean
  readonly decoyConfigured: boolean
  readonly wipeCodeConfigured: boolean
}

/**
 * Project the configuration down to what the active profile may see.
 *
 * From the decoy this reports a plain, ordinary PIN setup: no decoy section, no
 * wipe code, no disable. The asymmetry on `canDisable` is deliberate — offering
 * it in the decoy would let a coercer turn the gate off, which either strands
 * the real profile or keeps prompting anyway, and the second is the app lying
 * about what a switch did.
 *
 * The real profile's verifier survives a duress wipe (the wipe takes the seeds
 * and data, not the lock configuration), so this stays a plain "am I the default
 * profile" question — there is no post-wipe state where the decoy is the only
 * code left.
 */
export const visibleLockSettings = (config: LockConfig | undefined): VisibleLockSettings => {
  const isReal = getActiveProfile() === DEFAULT_PROFILE_ID

  return {
    configured: config !== undefined,
    mode: config?.mode,
    canManageDecoy: isReal,
    canDisable: isReal,
    decoyConfigured: isReal && hasDecoy(config),
    wipeCodeConfigured: isReal && hasWipeCode(config),
  }
}

/** Set the first PIN, or replace the active profile's own code. */
export const setRealPin = async (code: string, mode: PinMode, authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()

  // The very first PIN has nothing to authenticate against yet — the sentinel
  // is created as part of this call. Every later change is gated.
  if (existing !== undefined) {
    const gate = await requireLockGateAuth(authPrompt)
    if (gate !== 'ok') return {ok: false, reason: 'auth'}
  }

  await ensureLockGateSentinel()

  // Changing the real PIN re-salts and drops the other codes: they were hashed
  // under the old salt and cannot be re-derived without the plaintext. Silently
  // keeping stale hashes would leave a decoy whose code no longer opens
  // anything — a duress profile that fails exactly when it is needed.
  const salt = existing?.salt ?? (await newSalt())
  const others = existing === undefined ? [] : existing.verifiers.filter((v) => v.kind !== 'real')

  await writeLockConfig({
    version: 2,
    mode,
    salt,
    verifiers: [makeVerifier('real', code, salt), ...others],
  })
  return {ok: true}
}

export const setPinMode = async (mode: PinMode, authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()
  if (existing === undefined) return {ok: false, reason: 'not-configured'}

  const gate = await requireLockGateAuth(authPrompt)
  if (gate !== 'ok') return {ok: false, reason: 'auth'}

  await writeLockConfig({...existing, mode})
  return {ok: true}
}

/** Remove the PIN entirely. Never reachable from the decoy — see `visibleLockSettings`. */
export const disablePin = async (authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()
  if (existing === undefined) return {ok: true}

  const gate = await requireLockGateAuth(authPrompt)
  if (gate !== 'ok') return {ok: false, reason: 'auth'}

  await clearLockConfig()
  await clearLockGateSentinel()
  return {ok: true}
}

/** Add or replace the decoy code. */
export const setDecoyPin = async (code: string, authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()
  if (existing === undefined) return {ok: false, reason: 'not-configured'}

  const gate = await requireLockGateAuth(authPrompt)
  if (gate !== 'ok') return {ok: false, reason: 'auth'}

  const check = rejectDuplicate(existing, 'decoy', code)
  if (check !== undefined) return check

  const others = existing.verifiers.filter((v) => v.kind !== 'decoy')
  await writeLockConfig({...existing, verifiers: [...others, makeVerifier('decoy', code, existing.salt)]})

  // Arms the explanatory copy in the decoy's onboarding. Only set here — from the
  // real profile, by the user's own hand — so it can never greet a coercer.
  await markDecoySetupPending()
  // …and sends the next launch straight into the decoy, so the caller can restart
  // into its onboarding rather than asking for the code just chosen.
  await markBootIntoDecoy()
  return {ok: true}
}

/** Add or replace the wipe code. */
export const setWipeCode = async (code: string, authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()
  if (existing === undefined) return {ok: false, reason: 'not-configured'}

  const gate = await requireLockGateAuth(authPrompt)
  if (gate !== 'ok') return {ok: false, reason: 'auth'}

  const check = rejectDuplicate(existing, 'wipe', code)
  if (check !== undefined) return check

  const others = existing.verifiers.filter((v) => v.kind !== 'wipe')
  await writeLockConfig({...existing, verifiers: [...others, makeVerifier('wipe', code, existing.salt)]})
  return {ok: true}
}

/** Drop the decoy, the wipe code, or both. */
export const clearDecoyAndWipe = async (authPrompt?: string): Promise<LockMutationResult> => {
  const existing = await readLockConfig()
  if (existing === undefined) return {ok: false, reason: 'not-configured'}

  const gate = await requireLockGateAuth(authPrompt)
  if (gate !== 'ok') return {ok: false, reason: 'auth'}

  await writeLockConfig({...existing, verifiers: existing.verifiers.filter((v) => v.kind === 'real')})
  await clearDecoySetupPending()
  return {ok: true}
}

/**
 * Reject a proposed code that already belongs to another slot.
 *
 * Every code shares the config's one salt, so a proposed code hashes to exactly
 * the stored value when it collides — a real duplicate check without ever
 * holding another code in plaintext. Two identical codes would make one of them
 * unreachable, with match order deciding which.
 */
const rejectDuplicate = (config: LockConfig, kind: CodeKind, code: string): LockMutationResult | undefined => {
  const proposed = makeVerifier(kind, code, config.salt)
  const clashes = config.verifiers.some((v) => v.kind !== kind && v.hash === proposed.hash)
  return clashes ? {ok: false, reason: 'duplicate'} : undefined
}
