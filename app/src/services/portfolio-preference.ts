/**
 * Whether the portfolio shows tokens that are absent from the verified-token registry.
 *
 * Persisted rather than component state: the toggle exists for people who hold a token
 * the registry has never heard of — a fresh mint, a testnet faucet token, their own
 * asset — and for them "verified only" is not a preference, it is the setting that
 * hides what they came to look at. A filter that resets on every mount has to be
 * re-found after each navigation.
 *
 * Read through a change signal rather than a mount-time read, because both the
 * portfolio and the wallet home render the list and each tab's screen is kept alive by
 * the navigator: a value cached at mount would leave one tab filtering by a rule the
 * other just changed.
 *
 * @module
 */

import {logger} from '../logger'
import {storage, storageSupportsSyncGet} from '../platform/storage'

export const SHOW_UNVERIFIED_KEY = '@pnyx/portfolio/show-unverified'

const listeners = new Set<() => void>()

/**
 * Mirror of the stored value, used only where storage cannot be read synchronously.
 * Where it can, the snapshot reads through — a module-level cache would survive a
 * profile switch and show the real profile's choice inside the decoy.
 */
let mirrored = false
let hydrated = false

const notify = (): void => {
  for (const listener of listeners) listener()
}

const hydrate = async (): Promise<void> => {
  if (hydrated) return
  hydrated = true
  try {
    mirrored = (await storage.get(SHOW_UNVERIFIED_KEY)) === 'true'
    notify()
  } catch (e) {
    logger.warn('Failed to read the unverified-token filter', {origin: 'PortfolioPreference', error: String(e)})
  }
}

export const subscribeShowUnverified = (listener: () => void): (() => void) => {
  listeners.add(listener)
  if (!storageSupportsSyncGet) void hydrate()
  return () => {
    listeners.delete(listener)
  }
}

/** Defaults to hiding unverified tokens, which is what keeps spam dust out of the list. */
export const getShowUnverifiedSnapshot = (): boolean =>
  storageSupportsSyncGet ? storage.getSync(SHOW_UNVERIFIED_KEY) === 'true' : mirrored

/**
 * Store the choice, then announce it. In that order: a failed write leaves the toggle
 * where it was instead of showing a state nothing recorded.
 */
export const setShowUnverified = async (shown: boolean): Promise<void> => {
  try {
    await storage.set(SHOW_UNVERIFIED_KEY, shown ? 'true' : 'false')
    mirrored = shown
    hydrated = true
    notify()
  } catch (e) {
    logger.warn('Failed to persist the unverified-token filter', {origin: 'PortfolioPreference', error: String(e)})
  }
}
