/**
 * Biometric gate for changes to the lock configuration.
 *
 * Every mutation — setting or changing a PIN, changing the mode, creating or
 * removing the decoy, setting or clearing the wipe code — passes through here.
 * Without it, anyone holding a merely *unlocked* phone can reconfigure the whole
 * scheme, and a coercer already inside the decoy can probe it.
 *
 * **This is keystore-enforced, not a JS boolean.** `authenticateAsync` (used
 * elsewhere as `bareDeviceAuth`) returns a value to JS with the OS keystore
 * never involved, so anything that can patch the bundle can make it return
 * true. Instead a random sentinel is written to the keychain under the same
 * `BIOMETRY_ANY_OR_DEVICE_PASSCODE` access control as the seeds, and
 * *retrieving* it is the gate: the prompt is enforced by the OS, and no seed
 * material enters the heap for what is only a settings change.
 *
 * @module
 */

import {hex, randomBytes} from '@pnyx/crypto'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {createEnclaveMnemonicVault} from '../credential-vault'
import {evictGroupCeremony} from '../credential-vault/ceremony-cache'

/** Keychain slot for the sentinel. Not a wallet group, not an identity. */
const LOCK_GATE_SLOT = 'pnyx-lock-gate'

export type LockGateResult = 'ok' | 'cancelled' | 'unavailable'

/**
 * Create the sentinel. Called once, when the first PIN is set.
 *
 * Writing to the keychain does not prompt — only retrieval does — so this is
 * silent, which is right: the prompt belongs on the *change*, not on the setup
 * step the user is already standing in.
 */
export const ensureLockGateSentinel = async (): Promise<void> => {
  const vault = createEnclaveMnemonicVault()
  const exists = await Effect.runPromise(vault.has(LOCK_GATE_SLOT)).catch((e) => {
    // Reads as "no sentinel", so the next line writes a fresh one over whatever is there.
    logger.warn('[LockGate] sentinel probe failed while creating', {origin: 'LockGate', error: String(e)})
    return false
  })
  if (exists) return
  const secret = hex.encode(await Effect.runPromise(randomBytes(32)))
  await Effect.runPromise(vault.store(LOCK_GATE_SLOT, secret))
}

/** Remove the sentinel — the PIN is gone, so the gate has nothing left to guard. */
export const clearLockGateSentinel = async (): Promise<void> => {
  await Effect.runPromise(createEnclaveMnemonicVault().delete(LOCK_GATE_SLOT)).catch((e) => {
    logger.warn('[LockGate] failed to remove the sentinel', {origin: 'LockGate', error: String(e)})
  })
}

/**
 * Demand a fresh biometric before a configuration change.
 *
 * The ceremony cache is evicted first. Its five-minute TTL exists so a multi-tap
 * signing funnel does not prompt repeatedly, but here it would mean a change
 * made shortly after an unlock sails through with no prompt at all — silently
 * defeating the requirement. `evictGroupCeremony` is the same mechanism recovery
 * signing already uses to force a fresh prompt per press.
 */
export const requireLockGateAuth = async (authPrompt?: string): Promise<LockGateResult> => {
  const vault = createEnclaveMnemonicVault()

  const exists = await Effect.runPromise(vault.has(LOCK_GATE_SLOT)).catch((e) => {
    // A failed probe reports the gate as absent, which callers read as "nothing to guard".
    logger.warn('[LockGate] sentinel probe failed; reporting the gate unavailable', {
      origin: 'LockGate',
      error: String(e),
    })
    return false
  })
  if (!exists) return 'unavailable'

  evictGroupCeremony(LOCK_GATE_SLOT)

  try {
    await Effect.runPromise(vault.retrieve(LOCK_GATE_SLOT, authPrompt))
    return 'ok'
  } catch (error) {
    logger.info('[LockGate] auth refused', {origin: 'LockGate', error: String(error)})
    return 'cancelled'
  }
}
