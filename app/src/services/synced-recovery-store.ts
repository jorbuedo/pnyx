/**
 * Cross-device synced key/value store for the passkey recovery blob.
 *
 * The blob is passkey-wrapped ciphertext (useless without the PRF output), so
 * it is safe to hand to the user's own cloud. Each platform uses its native
 * synced store — the same trust domain as the passkey itself:
 *
 * - iOS (`.ios.ts`): a `cloudSync` keychain item → iCloud Keychain.
 * - Android (`.android.ts`): Google Block Store → the user's Google account.
 *
 * This module is the web/fallback: no synced store, so recovery stays
 * device-local (passkey recovery isn't offered on web anyway).
 *
 * @module
 */

/** Whether a cross-device synced store exists on this platform. */
export const isAvailable = (): boolean => false

export const setItem = (_key: string, _value: string): Promise<void> => {
  throw new Error('synced recovery store is unavailable on this platform')
}

export const getItem = (_key: string): Promise<string | null> => Promise.resolve(null)

export const removeItem = (_key: string): Promise<void> => Promise.resolve()
