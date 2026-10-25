/**
 * Wires lifecycle eviction triggers into the credential-vault ceremony
 * cache. Mounted once near the top of the provider tree.
 *
 * The cache itself is a strict process-local convenience for multi-sign
 * flows (see `services/credential-vault/ceremony-cache.ts`). This hook is
 * the place where we evict on user-visible state changes that the cache
 * module can't observe directly:
 *
 * - **AppState → background**: covers home-button / app-switcher / phone
 *   lock. Matches the conservative behavior of `useLockScreen` for the
 *   PIN session. `'inactive'` is deliberately NOT a trigger — iOS fires
 *   it for momentary system-modal overlays (Face ID prompt, permission
 *   sheet, Control Center), which would wipe the cache *during* the
 *   biometric prompt the cache is meant to skip. Same rationale as
 *   `useLockScreen`.
 * - **Lock-session timeout / explicit logout**: AuthProvider clears
 *   `isUnlocked`, which propagates here and forces a cache flush.
 *   Gated on a real `true → false` transition so the initial render
 *   (when `isUnlocked` is `false` before login) doesn't fire.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useRef} from 'react'
import {AppState} from 'react-native'
import {useAuth} from '../providers'
import {clearAllCeremonies} from '../services/credential-vault'
import {clearIdentityRoleKeys} from '../services/identity-role-keys'
import {restoreDustKeyBook} from '../services/midnight/dust-key-book'
import {forgetAllSyncKeys} from '../services/midnight/sync-keys-store'
import {stopAllUnshieldedFeeds} from '../services/midnight/wallet/unshielded-live'
import {shouldEvictOnAppStateChange, shouldEvictOnAuthChange} from './ceremony-cache-lifecycle-rules'
import {shouldEvictRoleKeysOnAppStateChange, shouldEvictRoleKeysOnAuthChange} from './identity-role-key-lifecycle-rules'

export function useCeremonyCacheLifecycle(): void {
  const {isUnlocked} = useAuth()
  const wasUnlockedRef = useRef(false)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (shouldEvictOnAppStateChange(state)) clearAllCeremonies()
      // Asymmetric by decision: ID role keys survive `background` and go only on
      // lock (Phase 16 item 42). The predicate is called rather than skipped so
      // the difference is explicit here instead of being an absent line.
      if (shouldEvictRoleKeysOnAppStateChange(state)) clearIdentityRoleKeys()
      // Same asymmetry, same reason: the Midnight sync keys survive `background`, because a phone
      // being backgrounded is not a security event and evicting there would re-prompt all day.
      if (shouldEvictRoleKeysOnAppStateChange(state)) forgetAllSyncKeys()
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (isUnlocked) {
      // ⚠️ **The other end of the sync keys' lifetime, and it belongs here** rather than in the unlock
      // flow: one hook owns residency, so the restore sits beside the eviction instead of two modules
      // each knowing half of it.
      //
      // Only on the transition, so a re-render does not re-read the keychain. Never awaited and never
      // able to fail: DUST going stale is a degraded convenience, and unlock must not be blocked by it.
      if (!wasUnlockedRef.current) Effect.runFork(restoreDustKeyBook())
      wasUnlockedRef.current = true
      return
    }
    if (shouldEvictOnAuthChange(wasUnlockedRef.current, isUnlocked)) clearAllCeremonies()
    if (shouldEvictRoleKeysOnAuthChange(wasUnlockedRef.current, isUnlocked)) clearIdentityRoleKeys()
    // Lock ends residency for the sync keys too. They are spend-capable, unlike the ID keys, so this
    // line is the one that keeps the hold honest — see `services/midnight/sync-keys.ts`.
    if (shouldEvictRoleKeysOnAuthChange(wasUnlockedRef.current, isUnlocked)) forgetAllSyncKeys()
    // The live unshielded feeds go with them. They hold a parsed UTxO set and a history in memory, and
    // a locked wallet must not be one whose balances are still being kept warm — nor leave a socket
    // open naming its address to the indexer. Not evicted on `background`, for the same reason the
    // keys are not: a backgrounded phone is not a security event.
    if (shouldEvictRoleKeysOnAuthChange(wasUnlockedRef.current, isUnlocked)) {
      Effect.runFork(stopAllUnshieldedFeeds())
    }
  }, [isUnlocked])
}
