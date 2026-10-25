/**
 * Pnyx content-service session.
 *
 * The session is bound to the dedicated identity wallet
 * (services/identity-wallet.ts) — a software-only seed in its own enclave
 * slot — NOT to the selected wallet group. Funds wallets (the Wallets tab)
 * can be added, switched, and deleted without touching the auth session.
 *
 * Sign-in paths (state machine in ./use-pnyx-session-state.ts):
 *  - post-onboarding: decrypt the identity seed through the enclave vault
 *    (OS biometric prompt) → SIWM → hold the JWT in memory.
 *  - end of onboarding: `signInWithMnemonic` signs in with the identity seed
 *    still in memory — no vault round-trip, no extra OS prompt.
 *
 * Only {address, network} are persisted — never the token: a JWT on disk
 * would outlive the enclave gate that produced it, so a cold start
 * re-authenticates deliberately (re-auth is one biometric tap, and honest).
 *
 * @module
 */

import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react'
import {logger} from '../logger'
import {hasIdentityMnemonic, retrieveIdentityMnemonic} from '../services/identity-wallet'
import {useDeviceRegistration} from './use-device-registration'
import {type PnyxSessionState, usePnyxSessionState} from './use-pnyx-session-state'

type PnyxSessionContextValue = PnyxSessionState & {
  /**
   * Whether the identity seed exists on this device. Undefined while the vault
   * probe is still resolving. Drives the boot gate (onboarding vs tabs) together
   * with the wallet list.
   */
  readonly identityEstablished: boolean | undefined
  /** Re-probe the identity slot — call after onboarding stores the seed. */
  readonly refreshIdentityEstablished: () => Promise<void>
  /**
   * Decrypt the identity seed (OS biometric prompt). For consumers that need the
   * raw seed — passkey-recovery enrollment, manual phrase backup.
   */
  readonly decryptIdentityMnemonic: () => Promise<string>
  /** User-facing identity display name (top bar / Id tab); undefined if unset. */
  /** Persist the identity display name (set at onboarding; rename later). */
}

const PnyxSessionContext = createContext<PnyxSessionContextValue | null>(null)

export function PnyxSessionProvider({children}: {children: ReactNode}) {
  const [identitySlot, setIdentitySlot] = useState<boolean | undefined>(undefined)
  const refreshIdentityEstablished = useCallback(async () => {
    try {
      setIdentitySlot(await hasIdentityMnemonic())
    } catch (error) {
      logger.warn('[PnyxSession] identity slot probe failed', {origin: 'PnyxSession', error: String(error)})
      setIdentitySlot(false)
    }
  }, [])
  useEffect(() => {
    void refreshIdentityEstablished()
  }, [refreshIdentityEstablished])

  // The identity slot is the only thing that can sign in. Onboarding creates it
  // unconditionally on the first-run path, and the add-wallet path only runs on an
  // install that already has one — so "a wallet group but no identity" is
  // unreachable, and there is no fallback to derive an identity from a group's
  // seed. (There was one, for installs predating the identity/wallet split; no
  // such install exists, so it was removed rather than carried.)
  const canSignIn = identitySlot

  const state = usePnyxSessionState({canSignIn, decryptIdentityMnemonic: retrieveIdentityMnemonic})

  useDeviceRegistration(state.session)
  // ⚠️ The DM background hooks are NOT mounted here. They read `useRealtime()`, and this provider
  // renders `RealtimeProvider` as a child — from up here that context is its inert default. They
  // live in `DmBackgroundTasks`, rendered below it.

  const value = useMemo<PnyxSessionContextValue>(
    () => ({
      ...state,
      identityEstablished: canSignIn,
      refreshIdentityEstablished,
      decryptIdentityMnemonic: retrieveIdentityMnemonic,
    }),
    [state, canSignIn, refreshIdentityEstablished],
  )

  return <PnyxSessionContext.Provider value={value}>{children}</PnyxSessionContext.Provider>
}

export function usePnyxSession(): PnyxSessionContextValue {
  const context = useContext(PnyxSessionContext)
  if (context === null) {
    throw new Error('usePnyxSession must be used within PnyxSessionProvider')
  }
  return context
}
