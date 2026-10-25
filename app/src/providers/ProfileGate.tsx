/**
 * The profile gate — chooses which namespace the app opens.
 *
 * Sits above every profile-scoped provider and below the presentation ones
 * (theme, i18n), which read only device-global keys. That placement is forced:
 * the existing `(lock)` route is a `Stack.Screen` mounted *below*
 * `ConfigProvider` / `WalletProvider` / `AuthProvider`, so by the time it renders
 * those providers have already read storage and the profile is settled. A PIN
 * there could verify a code but never select a profile.
 *
 * Children are keyed on the resolved profile id, mirroring the `key={network}`
 * remount `PlatformWalletProvider` already uses.
 *
 * @module
 */

import * as Linking from 'expo-linking'
import {type ReactNode, useCallback, useEffect, useState, useSyncExternalStore} from 'react'
import {logger} from '../logger'
import {isNative} from '../platform'
import {PinEntryScreen} from '../screens/PinEntryScreen'
import {hasIdentityMnemonic} from '../services/identity-wallet'
import {consumeDeepLink} from '../services/pending-deep-link'
import {getActiveProfile, isProfileAdopted, setActiveProfile} from '../services/profile/active-profile'
import {
  clearBootIntoDecoy,
  clearDecoySetupPending,
  isBootIntoDecoySync,
  isDecoySetupPendingSync,
} from '../services/profile/decoy-setup'
import {
  consumeGateLockRequest,
  isGateLockRequested,
  markGateOpen,
  subscribeGateLock,
} from '../services/profile/gate-state'
import {isArmedSync, type LockConfig, readLockConfigSync, resolveCode, setArmed} from '../services/profile/pin-config'
import {outcomeForCode} from '../services/profile/pin-outcome'
import {isPinRequired} from '../services/profile/pin-required'
import {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID, type ProfileId} from '../services/profile/profile-id'
import {resumePendingWipe, wipeProfile} from '../services/profile/profile-wipe'
import {reloadApp} from '../services/profile/reload-app'

/**
 * False only for the first gate mount of the process. A warm re-lock re-renders
 * the gate but is not a cold start, and the `coldStart` mode turns on that
 * distinction.
 */
let processStarted = false

export type ProfileGateProps = {
  children: ReactNode
  /** Digits in a profile PIN. */
  readonly pinLength?: number
}

export function ProfileGate({children, pinLength = 6}: ProfileGateProps) {
  const [config] = useState<LockConfig | undefined>(() => (isNative ? readLockConfigSync() : undefined))
  const [isColdStart, setIsColdStart] = useState(() => !processStarted)

  // A warm re-lock cannot re-mount this component — the lock route lives below
  // it — so the signal has to arrive from outside React. Without this,
  // `everyUnlock` and the manual lock would only ever apply on a cold start:
  // the PIN would look configured and quietly do nothing.
  const relockRequested = useSyncExternalStore(subscribeGateLock, isGateLockRequested, () => false)

  const required =
    isNative &&
    config !== undefined &&
    isPinRequired({
      configured: true,
      mode: config.mode,
      isColdStart,
      isArmed: isArmedSync(),
    })

  // Declared before `profileId` so its initialiser can read the resolved value.
  const [bootIntoDecoy] = useState(() => isNative && isBootIntoDecoySync())

  const [profileId, setProfileId] = useState<ProfileId | undefined>(() => {
    if (!isNative || config === undefined) {
      setActiveProfile(DEFAULT_PROFILE_ID)
      return DEFAULT_PROFILE_ID
    }
    // The user just created the decoy's code behind the keystore gate; open it
    // without asking them to type it back. One boot only — the intent is cleared
    // below and never grants a second free entry.
    if (bootIntoDecoy) {
      setActiveProfile(DECOY_PROFILE_ID)
      return DECOY_PROFILE_ID
    }
    return undefined
  })

  useEffect(() => {
    if (bootIntoDecoy) void clearBootIntoDecoy()
  }, [bootIntoDecoy])

  useEffect(() => {
    processStarted = true
  }, [])

  // A wipe killed part-way through finishes before anything else touches
  // storage. Idempotent, so a spurious run is harmless.
  useEffect(() => {
    if (isColdStart) void resumePendingWipe()
  }, [isColdStart])

  // Re-lock: drop back to the PIN screen.
  useEffect(() => {
    if (!relockRequested) return
    if (!isNative || config === undefined) return
    consumeGateLockRequest()
    setIsColdStart(false)
    setProfileId(undefined)
  }, [relockRequested, config])

  // No PIN needed this time round: adopt the profile already chosen for the
  // process (default on a cold start) without showing anything.
  useEffect(() => {
    if (profileId !== undefined || required) return
    const resolved = getActiveProfile()
    setActiveProfile(resolved)
    setProfileId(resolved)
  }, [profileId, required])

  const handleSubmit = useCallback(
    async (code: string): Promise<boolean> => {
      if (config === undefined) return false

      const kind = resolveCode(config, code)
      if (kind === undefined) return false

      const outcome = outcomeForCode(kind)
      await setArmed(false)

      // Switching profile inside a live process is not safe: module-scope state
      // (the MMKV handle, the installation id, the ceremony cache, the provider
      // registry, the price stores) survives a React remount and would keep
      // serving the previous profile. Reload instead, re-arming first so the
      // fresh process asks again and resolves the code from a clean slate.
      //
      // Only a genuine *switch* needs this. On the first challenge of a process
      // nothing profile-scoped has mounted, so any code is honoured in place —
      // comparing against `getActiveProfile()` alone treated a cold-start decoy
      // entry as a switch and bounced straight back to the PIN screen.
      if (isProfileAdopted() && outcome.profileId !== getActiveProfile()) {
        await setArmed(true)
        const restarted = await reloadApp()
        if (!restarted) {
          // Refuse rather than continue. Adopting in place would leave the
          // previous profile's module-scope state serving the new one — the
          // decoy PIN showing real data, which is the one outcome worse than an
          // unlock that fails. The gate stays up; a relaunch resolves cleanly
          // because a cold start has nothing to shed.
          logger.error('[ProfileGate] refusing profile switch: no restart mechanism', {origin: 'ProfileGate'})
          return false
        }
        return true
      }

      setActiveProfile(outcome.profileId)

      // The wipe runs behind the opened profile, never in front of it: both
      // codes must feel identical, so a visible delay on one of them is a tell.
      if (outcome.wipe) {
        void wipeProfile(DEFAULT_PROFILE_ID).catch((error: unknown) => {
          logger.warn('[ProfileGate] background wipe failed', {origin: 'ProfileGate', error: String(error)})
        })
      }

      setProfileId(outcome.profileId)
      return true
    },
    [config],
  )

  // Retire the decoy-setup explanation once it can no longer apply: the user is
  // back in their real profile (done, or given up), or the decoy already has an
  // identity. Leaving it armed would show "set up your second profile" to
  // whoever opens the decoy next — the one reader it must never have.
  useEffect(() => {
    if (profileId === undefined || !isDecoySetupPendingSync()) return
    if (profileId === DEFAULT_PROFILE_ID) {
      void clearDecoySetupPending()
      return
    }
    void hasIdentityMnemonic().then((exists) => {
      if (exists) void clearDecoySetupPending()
    })
  }, [profileId])

  // A link that arrived while the gate was up is released once a profile is
  // open. Links carry no wallet identity, so whichever profile opened honours
  // it exactly as it would have without the gate.
  useEffect(() => {
    if (profileId === undefined) return
    markGateOpen()
    void consumeDeepLink().then((url) => {
      if (url !== undefined) {
        logger.info('[ProfileGate] releasing buffered deep link', {origin: 'ProfileGate'})
        void Linking.openURL(url).catch((e) => {
          // The link was already consumed, so a failure here loses it for good.
          logger.warn('[ProfileGate] buffered deep link could not be opened', {
            origin: 'ProfileGate',
            error: String(e),
          })
        })
      }
    })
  }, [profileId])

  if (profileId === undefined) {
    return <PinEntryScreen length={pinLength} onSubmit={handleSubmit} testID="profile-gate-pin" />
  }

  return <ProfileScope key={profileId}>{children}</ProfileScope>
}

/** Remount boundary — every profile-scoped provider lives under this key. */
function ProfileScope({children}: {children: ReactNode}) {
  return <>{children}</>
}
