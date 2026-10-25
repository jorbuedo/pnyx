/**
 * Set or change a code — the real PIN, the decoy PIN, or the wipe code.
 *
 * Which one is decided by the `kind` route param. Every path through here is
 * biometric-gated inside `lock-settings.ts`; this screen only collects digits.
 *
 * @module
 */

import {router, useLocalSearchParams} from 'expo-router'
import {useCallback} from 'react'
import {useToast} from '../../src/hooks/useToast'
import {useI18n} from '../../src/providers'
import {PinSetupFlow} from '../../src/screens/PinSetupFlow'
import {setDecoyPin, setRealPin, setWipeCode} from '../../src/services/profile/lock-settings'
import type {PinMode} from '../../src/services/profile/pin-required'
import {reloadApp} from '../../src/services/profile/reload-app'

/**
 * Every code is the same length, including the emergency one. A different digit
 * count is visible to anyone watching the screen being unlocked, which would
 * announce the emergency code as something other than the normal PIN — the
 * exact observer this feature defends against.
 */
const PIN_LENGTH = 6

export default function PinSetupRoute() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const params = useLocalSearchParams<{kind?: string; mode?: string}>()
  const kind = params.kind === 'decoy' || params.kind === 'wipe' ? params.kind : 'real'

  const onComplete = useCallback(
    async (code: string): Promise<string | undefined> => {
      const prompt = t('settings.security.pin.authRequired')

      const result =
        kind === 'decoy'
          ? await setDecoyPin(code, prompt)
          : kind === 'wipe'
            ? await setWipeCode(code, prompt)
            : await setRealPin(code, (params.mode as PinMode | undefined) ?? 'coldStart', prompt)

      if (result.ok) {
        // Creating the decoy restarts straight into its onboarding. A switch
        // cannot be done in place (module-scope state would keep serving the real
        // profile), so this is a restart, not navigation. If the restart is
        // unavailable the flow still works — the settings row then tells the user
        // to lock and enter the second code — so a failure only costs a detour.
        if (kind === 'decoy') {
          const restarted = await reloadApp()
          if (restarted) return undefined
        }

        showToast({
          message:
            kind === 'decoy'
              ? t('settings.security.decoy.createdSuccess')
              : kind === 'wipe'
                ? t('settings.security.wipeCode.createdSuccess')
                : t('settings.security.pin.savedSuccess'),
        })
        router.back()
        return undefined
      }

      switch (result.reason) {
        case 'auth':
          return t('settings.security.pin.authFailed')
        case 'duplicate':
          return t('settings.security.pin.duplicateError')
        default:
          return t('settings.security.pin.authFailed')
      }
    },
    [kind, params.mode, showToast, t],
  )

  return (
    <PinSetupFlow
      length={PIN_LENGTH}
      title={
        kind === 'decoy'
          ? t('settings.security.decoy.pinTitle')
          : kind === 'wipe'
            ? t('settings.security.wipeCode.pinTitle')
            : t('settings.security.pin.setTitle')
      }
      onComplete={onComplete}
      testID={`pin-setup-${kind}`}
    />
  )
}
