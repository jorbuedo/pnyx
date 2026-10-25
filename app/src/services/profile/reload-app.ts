/**
 * Restart the JS runtime, for a profile switch.
 *
 * A switch cannot be done in place. `setActiveProfile` locks after the first
 * adoption, and module-scope state (the MMKV handle, the installation id, the
 * ceremony cache, the provider registry, the price stores) survives a React
 * remount — so continuing in-process would keep serving the *previous* profile
 * while the user believes they opened another. For a decoy that is the worst
 * possible outcome: the real profile's data behind the decoy's PIN.
 *
 * So this either restarts or reports failure. It never half-succeeds.
 *
 * @module
 */

import * as Updates from 'expo-updates'
import {DevSettings} from 'react-native'
import {logger} from '../../logger'

/**
 * Restart the app. Returns false when no mechanism is available, which callers
 * must treat as "the switch did not happen".
 *
 * `expo-updates`' `reloadAsync` is the production path but is **not supported in
 * development builds**, so `DevSettings.reload` covers development and both
 * builds have a working path.
 *
 * Both imports are static on purpose. A dynamic `await import(...)` goes through
 * Metro's `loadBundle`, and when HMR is unavailable its client falls back to
 * `window.location.reload()` — which does not exist on React Native and surfaces
 * as an unhandled `Cannot read property 'reload' of undefined` from `hmr.ts`.
 * There is no bundle-size argument for lazy-loading either module here.
 */
export const reloadApp = async (): Promise<boolean> => {
  if (__DEV__) {
    try {
      if (typeof DevSettings?.reload === 'function') {
        DevSettings.reload()
        return true
      }
    } catch (error) {
      logger.warn('[ReloadApp] DevSettings reload unavailable', {origin: 'ReloadApp', error: String(error)})
    }
  }

  try {
    if (typeof Updates?.reloadAsync !== 'function') {
      logger.error('[ReloadApp] expo-updates has no reloadAsync', {origin: 'ReloadApp'})
      return false
    }
    await Updates.reloadAsync()
    return true
  } catch (error) {
    logger.error('[ReloadApp] reload failed', {origin: 'ReloadApp', error: String(error)})
    return false
  }
}
