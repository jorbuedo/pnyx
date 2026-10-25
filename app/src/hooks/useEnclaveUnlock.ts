/**
 * The enclave unlock ceremony shared by both lock surfaces
 * (`app/index.tsx` cold start and `app/(lock)/login.tsx` auto-lock).
 *
 * Unlocking IS the SIWM sign-in: the enclave vault retrieve fires the single
 * OS biometric / device-passcode prompt and, with the decrypted mnemonic in
 * hand, immediately signs in with Midnight — so the user gets one prompt, not
 * one to unlock plus another to sign in. The app unlocks whenever the enclave
 * leg passes; a failed SIWM network leg leaves the session unset (the manual
 * `SignInCard` covers that retry) but does not block unlock.
 *
 * @module
 */

import {useCallback} from 'react'
import {usePnyxSession} from '../providers'
import {deviceAuth} from '../services/credential-vault/device-auth'

export function useEnclaveUnlock(): {unlock: () => Promise<boolean>} {
  const {signInForUnlock} = usePnyxSession()

  const unlock = useCallback(async (): Promise<boolean> => {
    const {authPassed, hadIdentity} = await signInForUnlock()
    if (hadIdentity) return authPassed
    // No identity seed resolved yet (transient state during vault-probe /
    // wallet hydration). Fall back to a bare OS auth so unlock is never
    // bricked; sign-in then happens via the SignInCard once it resolves.
    return deviceAuth()
  }, [signInForUnlock])

  return {unlock}
}
