/**
 * Device-lock capability probe.
 *
 * The enclave vault is the ONLY credential scheme: the wallet seed is
 * stored in the OS keychain under `BIOMETRY_ANY_OR_DEVICE_PASSCODE`, so
 * the device must have *some* screen-lock credential configured — a
 * biometric (preferred at prompt time) or a device passcode / PIN /
 * pattern (the OS-level fallback). A device with no screen lock at all
 * cannot protect the keychain entry; onboarding blocks on the
 * device-lock-required explainer until one is set up.
 *
 * We trust `expo-local-authentication`'s enrolled-level probe:
 * `SecurityLevel.SECRET` (1) means a device passcode is set,
 * `BIOMETRIC_WEAK`/`BIOMETRIC_STRONG` imply a passcode as well (both
 * platforms require one before enrolling a biometric).
 *
 * @module
 */

import * as LocalAuthentication from 'expo-local-authentication'
import {Platform} from 'react-native'
import {logger} from '../logger'
import {isInsecureDevVaultEnabled} from './credential-vault/insecure-dev-vault'

export type DeviceLockCapability =
  | {readonly kind: 'capable'}
  | {readonly kind: 'incapable'; readonly reason: DeviceLockIncapableReason}

export type DeviceLockIncapableReason = 'platform-unsupported' | 'no-device-lock' | 'probe-error'

const isNative = Platform.OS === 'ios' || Platform.OS === 'android'

/**
 * Run the capability probe.
 *
 * Returns a tagged result so callers can branch on the specific reason
 * (e.g. surface "set up a screen lock" UX when reason is 'no-device-lock').
 */
export const probeDeviceLockCapability = async (): Promise<DeviceLockCapability> => {
  // The insecure dev vault stores seeds outside the keychain, so there is no
  // entry for a device lock to protect — the gate would only block UI work.
  if (isInsecureDevVaultEnabled()) {
    return {kind: 'capable'}
  }
  if (!isNative) {
    return {kind: 'incapable', reason: 'platform-unsupported'}
  }

  try {
    const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync()
    if (enrolledLevel < LocalAuthentication.SecurityLevel.SECRET) {
      return {kind: 'incapable', reason: 'no-device-lock'}
    }
    return {kind: 'capable'}
  } catch (error) {
    logger.error('Device-lock capability probe failed', {origin: 'keychain-capability', error})
    return {kind: 'incapable', reason: 'probe-error'}
  }
}

/**
 * Convenience helper — `true` iff the device passes the probe.
 */
export const hasDeviceLock = async (): Promise<boolean> => {
  const probe = await probeDeviceLockCapability()
  return probe.kind === 'capable'
}
