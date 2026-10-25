/**
 * Platform-aware label for how the OS surfaces biometric / passcode unlock.
 *
 * Returns a mid-sentence phrase (e.g. "Face ID, Touch ID, or your device
 * passcode" on iOS, "your fingerprint, face unlock, or device PIN" on
 * Android). Designed for interpolation into copy like
 * `t('…', {methods: useBiometricMethodsLabel()})`.
 *
 * Web / extension fall back to a generic phrase — they never run the
 * enclave path but the helper stays usable so call sites don't need to
 * platform-guard.
 *
 * @module
 */

import {platformIsAndroid, platformIsIOS} from '../platform'
import {useI18n} from '../providers'

export function useBiometricMethodsLabel(): string {
  const {t} = useI18n()
  if (platformIsIOS) return t('common.biometricMethods.ios')
  if (platformIsAndroid) return t('common.biometricMethods.android')
  return t('common.biometricMethods.generic')
}
