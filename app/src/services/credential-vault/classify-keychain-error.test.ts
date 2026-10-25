import {describe, expect, it} from 'vitest'
import {classifyKeychainError} from './classify-keychain-error'

const make = (code: string, message: string): Error => {
  const err = new Error(message)
  Object.defineProperty(err, 'code', {value: code, enumerable: true})
  return err
}

describe('classifyKeychainError — Android', () => {
  it('classifies E_KEYSTORE_ACCESS_ERROR as key-invalidated', () => {
    // KeyStoreAccessException, incl. KeyPermanentlyInvalidatedException
    // surfaced through KeychainModule.getGenericPassword catch chain.
    const err = make('E_KEYSTORE_ACCESS_ERROR', 'Key permanently invalidated')
    expect(classifyKeychainError(err, 'android')).toBe('key-invalidated')
  })

  it('classifies E_CRYPTO_FAILED with biometric-prompt prefix as auth-cancelled (user-canceled)', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 10, msg: User canceled the operation')
    expect(classifyKeychainError(err, 'android')).toBe('auth-cancelled')
  })

  it('classifies E_CRYPTO_FAILED with biometric-prompt prefix as auth-cancelled (negative-button)', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 13, msg: Cancel')
    expect(classifyKeychainError(err, 'android')).toBe('auth-cancelled')
  })

  it('classifies E_CRYPTO_FAILED with lockout prefix as auth-cancelled', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 7, msg: Too many attempts. Try again later.')
    expect(classifyKeychainError(err, 'android')).toBe('auth-cancelled')
  })

  it('classifies E_CRYPTO_FAILED with permanent-lockout prefix as auth-cancelled', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 9, msg: Permanently locked out')
    expect(classifyKeychainError(err, 'android')).toBe('auth-cancelled')
  })

  it('classifies E_CRYPTO_FAILED with unknown prompt code as auth-cancelled (safer to re-prompt)', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 4, msg: Unable to process')
    expect(classifyKeychainError(err, 'android')).toBe('auth-cancelled')
  })

  it('classifies E_CRYPTO_FAILED without prompt prefix as key-invalidated (AEADBadTag)', () => {
    // CipherStorageBase.decryptBytes wraps AEADBadTagException with this
    // message. Previously, the regex matched "Authentication tag verification failed"
    // and we mis-routed to auth-cancelled, hanging the UI.
    const err = make(
      'E_CRYPTO_FAILED',
      'Decryption failed: Authentication tag verification failed. This usually indicates that the encrypted data was modified, corrupted, or is being decrypted with the wrong key.',
    )
    expect(classifyKeychainError(err, 'android')).toBe('key-invalidated')
  })

  it('classifies E_CRYPTO_FAILED without prompt prefix as key-invalidated (UserNotAuthenticated rewrap)', () => {
    // android.security.keystore.UserNotAuthenticatedException — raised
    // from inside decryptBytes after successful biometric when the key
    // has been invalidated.
    const err = make('E_CRYPTO_FAILED', 'Key user not authenticated')
    expect(classifyKeychainError(err, 'android')).toBe('key-invalidated')
  })

  it('classifies E_CRYPTO_FAILED without prompt prefix as key-invalidated (empty message)', () => {
    const err = make('E_CRYPTO_FAILED', '')
    expect(classifyKeychainError(err, 'android')).toBe('key-invalidated')
  })

  it('classifies E_UNKNOWN_ERROR as storage', () => {
    const err = make('E_UNKNOWN_ERROR', 'something we did not anticipate')
    expect(classifyKeychainError(err, 'android')).toBe('storage')
  })

  it('classifies E_EMPTY_PARAMETERS as storage', () => {
    const err = make('E_EMPTY_PARAMETERS', 'you passed empty or null username/password')
    expect(classifyKeychainError(err, 'android')).toBe('storage')
  })
})

describe('classifyKeychainError — iOS', () => {
  it('classifies errSecUserCanceled (-128) as auth-cancelled', () => {
    const err = make('-128', 'User canceled the operation.')
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('classifies LAErrorUserCancel (-2) as auth-cancelled', () => {
    const err = make('-2', 'Authentication canceled by user.')
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('classifies LAErrorUserFallback (-3) as auth-cancelled', () => {
    const err = make('-3', 'User tapped the fallback button (Enter Password).')
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('classifies LAErrorSystemCancel (-4) as auth-cancelled', () => {
    const err = make('-4', 'Authentication was canceled by system.')
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('classifies errSecAuthFailed (-25293) as key-invalidated', () => {
    const err = make('-25293', 'The user name or passphrase you entered is not correct.')
    expect(classifyKeychainError(err, 'ios')).toBe('key-invalidated')
  })

  it('classifies LAErrorBiometryLockout (-8) as auth-cancelled (temporary lockout, recoverable via passcode/wait)', () => {
    // Per Cursor Bugbot on PR #1967: -8 is recoverable (wait or use
    // device passcode). Routing it through the permanent re-import sheet
    // would push users into needless seed re-imports.
    const err = make('-8', 'Biometry is locked out.')
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('classifies unknown code as storage', () => {
    const err = make('-25300', 'The specified item could not be found in the keychain.')
    expect(classifyKeychainError(err, 'ios')).toBe('storage')
  })

  it('classifies missing code as storage', () => {
    expect(classifyKeychainError(new Error('boom'), 'ios')).toBe('storage')
  })
})

describe('classifyKeychainError — non-mobile platforms', () => {
  it('returns storage for web (enclave never runs there)', () => {
    const err = make('E_CRYPTO_FAILED', 'code: 10, msg: User canceled')
    expect(classifyKeychainError(err, 'web')).toBe('storage')
  })
})

describe('classifyKeychainError — numeric error.code coercion', () => {
  it('coerces a numeric iOS code so the key-invalidated recovery path still fires', () => {
    // RNKeychainManager.m stringifies before crossing the bridge today,
    // but a future RN bridge / a non-Keychain native module reaching
    // here with a numeric `code` shouldn't silently fall through to
    // `storage`. Tested for the errSecAuthFailed path.
    const err = Object.assign(new Error('Auth failed'), {code: -25293})
    expect(classifyKeychainError(err, 'ios')).toBe('key-invalidated')
  })

  it('coerces numeric -128 (errSecUserCanceled) to auth-cancelled', () => {
    const err = Object.assign(new Error('User canceled'), {code: -128})
    expect(classifyKeychainError(err, 'ios')).toBe('auth-cancelled')
  })

  it('ignores non-finite numeric codes (NaN / Infinity)', () => {
    const err = Object.assign(new Error('?'), {code: Number.NaN})
    expect(classifyKeychainError(err, 'ios')).toBe('storage')
  })
})

describe('classifyKeychainError — non-Error inputs', () => {
  it('returns storage for null', () => {
    expect(classifyKeychainError(null, 'android')).toBe('storage')
  })

  it('returns storage for undefined', () => {
    expect(classifyKeychainError(undefined, 'android')).toBe('storage')
  })

  it('returns storage for a plain object without code', () => {
    expect(classifyKeychainError({message: 'no code field'}, 'android')).toBe('storage')
  })

  it('returns storage for a string', () => {
    expect(classifyKeychainError('User canceled the operation', 'android')).toBe('storage')
  })
})
