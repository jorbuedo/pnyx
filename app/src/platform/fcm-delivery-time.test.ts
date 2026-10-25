import {describe, expect, it} from 'vitest'
import {MIN_PLAUSIBLE_EPOCH_MS, resolveFcmDeliveryMs} from './fcm-delivery-time'

const REAL_MS = 1_700_000_000_000 // 2023-11-14, a real epoch-ms

describe('resolveFcmDeliveryMs', () => {
  it('accepts a real epoch-ms sentTime', () => {
    expect(resolveFcmDeliveryMs(REAL_MS, undefined)).toBe(REAL_MS)
  })

  it('rejects the Android Int32-clamped sentTime (≈1970-01-25)', () => {
    // 2147483647 is the exact value behind the "Jan 25 1970" date bug.
    expect(resolveFcmDeliveryMs(2_147_483_647, undefined)).toBeNull()
  })

  it('rejects a seconds-based value (~1.7e9)', () => {
    expect(resolveFcmDeliveryMs(1_700_000_000, undefined)).toBeNull()
  })

  it('falls back to a plausible google.sent_time number when sentTime is clamped', () => {
    expect(resolveFcmDeliveryMs(2_147_483_647, REAL_MS)).toBe(REAL_MS)
  })

  it('parses a plausible google.sent_time string', () => {
    expect(resolveFcmDeliveryMs(undefined, String(REAL_MS))).toBe(REAL_MS)
  })

  it('rejects a too-small google.sent_time string', () => {
    expect(resolveFcmDeliveryMs(undefined, '1700000000')).toBeNull()
  })

  it('returns null when neither value is plausible', () => {
    expect(resolveFcmDeliveryMs(0, undefined)).toBeNull()
    expect(resolveFcmDeliveryMs(undefined, undefined)).toBeNull()
  })

  it('floor is 2001-09-09', () => {
    expect(MIN_PLAUSIBLE_EPOCH_MS).toBe(1_000_000_000_000)
  })
})
