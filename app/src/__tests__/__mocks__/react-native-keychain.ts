/**
 * Minimal react-native-keychain stub for vitest.
 *
 * The package's `react-native` package.json field points at raw `./src/index`
 * TypeScript, which vitest externalizes and Node then fails to parse
 * ("Unexpected token 'typeof'"). The native module also can't run under Node.
 * This stub mirrors the public enum + function surface so modules that import
 * keychain (credential-vault → enclave-vault) load, defaulting to an empty
 * keychain. Enum string values match react-native-keychain v10.
 */

export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
} as const

export const ACCESS_CONTROL = {
  USER_PRESENCE: 'UserPresence',
  BIOMETRY_ANY: 'BiometryAny',
  BIOMETRY_CURRENT_SET: 'BiometryCurrentSet',
  DEVICE_PASSCODE: 'DevicePasscode',
  APPLICATION_PASSWORD: 'ApplicationPassword',
  BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BiometryAnyOrDevicePasscode',
  BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'BiometryCurrentSetOrDevicePasscode',
} as const

export const AUTHENTICATION_TYPE = {
  DEVICE_PASSCODE_OR_BIOMETRICS: 'AuthenticationWithBiometricsDevicePasscode',
  BIOMETRICS: 'AuthenticationWithBiometrics',
} as const

export const SECURITY_LEVEL = {
  SECURE_SOFTWARE: 'MOCK_SECURE_SOFTWARE',
  SECURE_HARDWARE: 'MOCK_SECURE_HARDWARE',
  ANY: 'MOCK_ANY',
} as const

export const BIOMETRY_TYPE = {
  TOUCH_ID: 'TouchID',
  FACE_ID: 'FaceID',
  OPTIC_ID: 'OpticID',
  FINGERPRINT: 'Fingerprint',
  FACE: 'Face',
  IRIS: 'Iris',
} as const

export const STORAGE_TYPE = {
  AES_CBC: 'KeystoreAESCBC',
  AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth',
  AES_GCM: 'KeystoreAESGCM',
  RSA: 'KeystoreRSAECB',
} as const

export const setGenericPassword = () => Promise.resolve({service: 'mock', storage: STORAGE_TYPE.AES_GCM as string})
export const getGenericPassword = () => Promise.resolve(false)
export const hasGenericPassword = () => Promise.resolve(false)
export const resetGenericPassword = () => Promise.resolve(true)
export const getAllGenericPasswordServices = () => Promise.resolve([] as string[])
export const hasInternetCredentials = () => Promise.resolve(false)
export const setInternetCredentials = () => Promise.resolve({service: 'mock', storage: STORAGE_TYPE.AES_GCM as string})
export const getInternetCredentials = () => Promise.resolve(false)
export const resetInternetCredentials = () => Promise.resolve()
export const getSupportedBiometryType = () => Promise.resolve(null)
export const canImplyAuthentication = () => Promise.resolve(false)
export const getSecurityLevel = () => Promise.resolve(SECURITY_LEVEL.SECURE_SOFTWARE as string)
export const isPasscodeAuthAvailable = () => Promise.resolve(false)
export const requestSharedWebCredentials = () => Promise.resolve(false)
export const setSharedWebCredentials = () => Promise.resolve()
