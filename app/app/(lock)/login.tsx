/**
 * Lock screen login route.
 *
 * Shown when the app returns from background after the inactivity
 * timeout. Mounts the enclave-native lock screen (OS biometric prompt
 * with device-passcode fallback). On success the user is returned to
 * the previous screen.
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback} from 'react'

import {useEnclaveUnlock} from '../../src/hooks/useEnclaveUnlock'
import {markSessionAuthenticated} from '../../src/hooks/useLockScreen'
import {useAuth} from '../../src/providers'
import {BiometricFirstLockScreen} from '../../src/screens/BiometricFirstLockScreen'

export default function LockLoginScreen() {
  const {unlockSession} = useAuth()
  const {unlock} = useEnclaveUnlock()

  const handleSuccess = useCallback(() => {
    unlockSession()
    markSessionAuthenticated()
    router.back()
  }, [unlockSession])

  return (
    <BiometricFirstLockScreen
      onSuccess={handleSuccess}
      onRecovery={() => router.navigate('/(lock)/reset-wallet')}
      unlock={unlock}
      blockHardwareBack
      origin="LockLoginScreen"
    />
  )
}
