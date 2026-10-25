/**
 * Tests for the enclave unlock ceremony: pass through the session's
 * authPassed verdict when an identity exists, and fall back to a bare OS
 * auth (so unlock is never bricked) when no identity is resolved yet.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('react', () => ({useCallback: (fn: unknown) => fn}))

const {signInForUnlock, authenticateAsync, loggerWarn} = vi.hoisted(() => ({
  signInForUnlock: vi.fn(),
  authenticateAsync: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('../providers', () => ({usePnyxSession: () => ({signInForUnlock})}))
vi.mock('expo-local-authentication', () => ({authenticateAsync}))
vi.mock('../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn()}}))

import {useEnclaveUnlock} from './useEnclaveUnlock'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useEnclaveUnlock', () => {
  it('unlocks when the enclave ceremony reports authPassed with an identity', async () => {
    signInForUnlock.mockResolvedValue({authPassed: true, hadIdentity: true})

    await expect(useEnclaveUnlock().unlock()).resolves.toBe(true)
    expect(authenticateAsync).not.toHaveBeenCalled()
  })

  it('stays locked when the enclave leg fails (authPassed false) with an identity', async () => {
    signInForUnlock.mockResolvedValue({authPassed: false, hadIdentity: true})

    await expect(useEnclaveUnlock().unlock()).resolves.toBe(false)
    expect(authenticateAsync).not.toHaveBeenCalled()
  })

  it('falls back to a bare OS auth when no identity is resolved', async () => {
    signInForUnlock.mockResolvedValue({authPassed: false, hadIdentity: false})
    authenticateAsync.mockResolvedValue({success: true})

    await expect(useEnclaveUnlock().unlock()).resolves.toBe(true)
    expect(authenticateAsync).toHaveBeenCalledExactlyOnceWith({disableDeviceFallback: false})
  })

  it('returns false when the fallback OS auth throws', async () => {
    signInForUnlock.mockResolvedValue({authPassed: false, hadIdentity: false})
    authenticateAsync.mockRejectedValue(new Error('no hardware'))

    await expect(useEnclaveUnlock().unlock()).resolves.toBe(false)
    expect(loggerWarn).toHaveBeenCalledOnce()
  })
})
