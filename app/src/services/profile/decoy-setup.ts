/**
 * The "you are setting up the decoy" one-shot.
 *
 * Onboarding inside the decoy needs different copy — it should say what the
 * profile is for instead of welcoming a new user. But that copy must **never**
 * appear to someone who merely lands in an un-onboarded decoy: a coercer who
 * enters it and reads "you are setting up a decoy profile" learns the one thing
 * the whole feature exists to hide.
 *
 * So the explanation is gated on this flag, set only when the user deliberately
 * creates the decoy PIN from their real profile, and cleared as soon as the
 * decoy is onboarded or the user returns to the real profile. Absent the flag,
 * the decoy shows the ordinary welcome — indistinguishable from a fresh install.
 *
 * Device-global, because it is written from one profile and read in another.
 *
 * @module
 */

import {deviceStorage} from '../../platform/storage'
import {DECOY_PROFILE_ID, type ProfileId} from './profile-id'

const PENDING_KEY = '@pnyx/decoy-setup-pending'

/**
 * One-shot: "the next launch should open the decoy, without asking for a code".
 *
 * Set when the user creates the decoy PIN, so the app can restart straight into
 * the decoy's onboarding instead of making them lock the app and re-enter the
 * code they chose seconds ago. Safe to skip the challenge for that one boot:
 * reaching this point already required passing the keystore-backed config gate.
 * Consumed on read, so it never grants a second free entry.
 */
const BOOT_INTO_DECOY_KEY = '@pnyx/decoy-boot-intent'

export const markDecoySetupPending = async (): Promise<void> => {
  await deviceStorage.set(PENDING_KEY, '1')
}

export const clearDecoySetupPending = async (): Promise<void> => {
  await deviceStorage.remove(PENDING_KEY)
  await deviceStorage.remove(BOOT_INTO_DECOY_KEY)
}

/** Synchronous — onboarding reads it during render. */
export const isDecoySetupPendingSync = (): boolean => deviceStorage.getSync(PENDING_KEY) === '1'

export const markBootIntoDecoy = async (): Promise<void> => {
  await deviceStorage.set(BOOT_INTO_DECOY_KEY, '1')
}

/**
 * Read the boot intent. Deliberately does not clear it — the gate reads this in
 * a render initialiser, which React may run more than once, and consuming there
 * would drop the intent on the discarded pass. {@link clearBootIntoDecoy} runs
 * from an effect instead.
 */
export const isBootIntoDecoySync = (): boolean => deviceStorage.getSync(BOOT_INTO_DECOY_KEY) === '1'

export const clearBootIntoDecoy = async (): Promise<void> => {
  await deviceStorage.remove(BOOT_INTO_DECOY_KEY)
}

/**
 * Should onboarding explain that this is a decoy?
 *
 * Pure, so the leak condition is testable: only ever true inside the decoy, and
 * only while the user's own setup is in flight.
 */
export const shouldExplainDecoySetup = (activeProfile: ProfileId, pending: boolean): boolean =>
  activeProfile === DECOY_PROFILE_ID && pending
