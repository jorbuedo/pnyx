import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateAsync: vi.fn(async () => ({success: true})),
  insecureEnabled: vi.fn(() => false),
}))

vi.mock('expo-local-authentication', () => ({authenticateAsync: mocks.authenticateAsync}))
vi.mock('./insecure-dev-vault', () => ({isInsecureDevVaultEnabled: mocks.insecureEnabled}))

import {deviceAuth} from './device-auth'

beforeEach(() => {
  mocks.authenticateAsync.mockClear()
  mocks.authenticateAsync.mockResolvedValue({success: true})
  mocks.insecureEnabled.mockReturnValue(false)
})

describe('deviceAuth', () => {
  it('asks the OS when the dev bypass is off', async () => {
    await expect(deviceAuth()).resolves.toBe(true)
    expect(mocks.authenticateAsync).toHaveBeenCalledWith({disableDeviceFallback: false})
  })

  it('passes the OS refusal through', async () => {
    mocks.authenticateAsync.mockResolvedValue({success: false})
    await expect(deviceAuth()).resolves.toBe(false)
  })

  it('treats an unavailable gate as a refusal rather than a pass', async () => {
    mocks.authenticateAsync.mockRejectedValue(new Error('no hardware'))
    await expect(deviceAuth()).resolves.toBe(false)
  })

  it('does not prompt at all under the dev bypass', async () => {
    // The whole point: EXPO_PUBLIC_INSECURE_DEV_VAULT covered the keychain but not this second gate, so
    // a dev build still stopped at an OS passcode dialog.
    mocks.insecureEnabled.mockReturnValue(true)
    await expect(deviceAuth()).resolves.toBe(true)
    expect(mocks.authenticateAsync).not.toHaveBeenCalled()
  })
})
