/**
 * Tests for the device-lock capability probe.
 *
 * Pinned shapes:
 *  - Web always reports `platform-unsupported` (mobile-only app).
 *  - `getEnrolledLevelAsync() === NONE` (no passcode, no biometric) →
 *    `no-device-lock` — onboarding blocks on the explainer.
 *  - SECRET (device passcode / PIN / pattern only) → capable. The enclave
 *    vault stores under `BIOMETRY_ANY_OR_DEVICE_PASSCODE`, so the
 *    passcode is a valid gate; the OS prompt falls back to it.
 *  - Any enrolled biometric (WEAK or STRONG) → capable — both imply a
 *    device passcode exists underneath.
 *  - Probe-level throw → `probe-error`.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

const platformOS = vi.hoisted(() => ({current: 'ios' as 'ios' | 'android' | 'web'}))
const localAuth = vi.hoisted(() => ({
  getEnrolledLevelAsync: vi.fn<() => Promise<number>>(),
  SecurityLevel: {
    NONE: 0,
    SECRET: 1,
    BIOMETRIC_WEAK: 2,
    BIOMETRIC_STRONG: 3,
  } as const,
}))

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformOS.current
    },
  },
}))
vi.mock('expo-local-authentication', () => localAuth)
vi.mock('../logger', () => ({logger: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}))

describe('probeDeviceLockCapability', () => {
  beforeEach(() => {
    vi.resetModules()
    localAuth.getEnrolledLevelAsync.mockReset()
  })

  const loadProbe = async () => {
    const mod = await import('./keychain-capability')
    return mod.probeDeviceLockCapability
  }

  it('reports platform-unsupported on web', async () => {
    platformOS.current = 'web'
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'incapable', reason: 'platform-unsupported'})
  })

  it('reports no-device-lock when nothing is enrolled (NONE)', async () => {
    platformOS.current = 'android'
    localAuth.getEnrolledLevelAsync.mockResolvedValue(localAuth.SecurityLevel.NONE)
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'incapable', reason: 'no-device-lock'})
  })

  it('reports capable with a device passcode only (SECRET) — OS-level fallback covers unlock', async () => {
    platformOS.current = 'android'
    localAuth.getEnrolledLevelAsync.mockResolvedValue(localAuth.SecurityLevel.SECRET)
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'capable'})
  })

  it('reports capable with a WEAK biometric (implies a passcode underneath)', async () => {
    platformOS.current = 'android'
    localAuth.getEnrolledLevelAsync.mockResolvedValue(localAuth.SecurityLevel.BIOMETRIC_WEAK)
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'capable'})
  })

  it('reports capable with a STRONG biometric on iOS', async () => {
    platformOS.current = 'ios'
    localAuth.getEnrolledLevelAsync.mockResolvedValue(localAuth.SecurityLevel.BIOMETRIC_STRONG)
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'capable'})
  })

  it('reports probe-error when the underlying check throws', async () => {
    platformOS.current = 'android'
    localAuth.getEnrolledLevelAsync.mockRejectedValue(new Error('boom'))
    const probe = await loadProbe()
    expect(await probe()).toEqual({kind: 'incapable', reason: 'probe-error'})
  })
})

describe('hasDeviceLock', () => {
  beforeEach(() => {
    vi.resetModules()
    localAuth.getEnrolledLevelAsync.mockReset()
  })

  it('returns true when the probe is capable', async () => {
    platformOS.current = 'android'
    localAuth.getEnrolledLevelAsync.mockResolvedValue(localAuth.SecurityLevel.SECRET)
    const {hasDeviceLock} = await import('./keychain-capability')
    expect(await hasDeviceLock()).toBe(true)
  })

  it('returns false when the probe is incapable', async () => {
    platformOS.current = 'web'
    const {hasDeviceLock} = await import('./keychain-capability')
    expect(await hasDeviceLock()).toBe(false)
  })
})
