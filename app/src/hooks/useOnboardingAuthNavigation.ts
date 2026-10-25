/**
 * Shared onboarding navigation logic for enclave enrollment.
 *
 * After mnemonic creation/verification/restore, the wallet seed goes
 * straight into the enclave vault — biometric permission and the enclave
 * key ceremony happen on `secure-with-biometrics` / `preparing`. There is
 * no password or PIN alternative.
 *
 * The only branch: a device without any screen-lock credential (no
 * biometric AND no passcode) cannot protect the keychain entry — those
 * users land on the blocking `device-lock-required` explainer until a
 * device lock is configured.
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback, useEffect, useRef} from 'react'

import {hasDeviceLock} from '../services/keychain-capability'
import {resolveDeviceLock} from './device-lock-gate'

type NavigationMode = 'push' | 'replace'
type OnboardingAuthRoute =
  | '/onboarding/secure-with-biometrics'
  | '/onboarding/device-lock-required'
  | '/onboarding/preparing'

/**
 * Where to go when the device *does* have a lock.
 *
 * The identity run passes `/onboarding/preparing`: its avatar step already carries the
 * "Continue with biometrics" action, so routing through the explainer would be a second tap that
 * says the same thing. The add-wallet run still needs that screen — it collects the wallet name.
 */
type AuthSetupTarget = Extract<OnboardingAuthRoute, '/onboarding/secure-with-biometrics' | '/onboarding/preparing'>

/**
 * Returns a `navigateToAuthSetup` function that decides the next onboarding step.
 */
export function useOnboardingAuthNavigation() {
  // Started when the screen appears, not when the button is pressed. The probe is a native round
  // trip, and running it on the tap is what made "Continue with biometrics" sit there before
  // anything moved — every screen here awaited it with no feedback on screen.
  const warmed = useRef<Promise<boolean> | null>(null)
  useEffect(() => {
    warmed.current = hasDeviceLock()
  }, [])

  const navigateToAuthSetup = useCallback(
    async (mode: NavigationMode = 'push', target: AuthSetupTarget = '/onboarding/secure-with-biometrics') => {
      const {capable, cache} = await resolveDeviceLock(warmed.current, hasDeviceLock)
      warmed.current = cache
      const route: OnboardingAuthRoute = capable ? target : '/onboarding/device-lock-required'

      if (mode === 'replace') {
        router.replace(route as Parameters<typeof router.replace>[0])
      } else {
        router.push(route as Parameters<typeof router.push>[0])
      }
    },
    [],
  )

  return {navigateToAuthSetup}
}
