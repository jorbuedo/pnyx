/**
 * Tests for THP pairing-method selection.
 *
 * SkipPairing proves possession of the device static key but NOT device
 * authenticity, so it must never be auto-accepted from a device-advertised list.
 * Selection prefers the user-verified CodeEntry method and only falls back to
 * SkipPairing behind an explicit host opt-in.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {selectThpPairingMethod} from './handshake-orchestration.js'
import {ThpPairingMethod} from './types.js'

describe('selectThpPairingMethod', () => {
  it('prefers CodeEntry when the device offers both CodeEntry and SkipPairing', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.SkipPairing, ThpPairingMethod.CodeEntry])).toBe(
      ThpPairingMethod.CodeEntry,
    )
    // Even when SkipPairing is explicitly allowed, the user-verified method wins.
    expect(selectThpPairingMethod([ThpPairingMethod.SkipPairing, ThpPairingMethod.CodeEntry], true)).toBe(
      ThpPairingMethod.CodeEntry,
    )
  })

  it('refuses (returns null) when the device only offers SkipPairing and it is not allowed', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.SkipPairing])).toBeNull()
  })

  it('uses SkipPairing only when explicitly allowed and no CodeEntry is offered', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.SkipPairing], true)).toBe(ThpPairingMethod.SkipPairing)
  })

  it('selects CodeEntry when it is the only method offered', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.CodeEntry])).toBe(ThpPairingMethod.CodeEntry)
  })

  it('returns null when no supported method is offered', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.QrCode, ThpPairingMethod.NFC])).toBeNull()
    expect(selectThpPairingMethod([], true)).toBeNull()
  })

  it('skips CodeEntry when no pairing-code callback is available, falling back to opted-in SkipPairing', () => {
    // Both offered, SkipPairing opted in, but the host has no way to collect a
    // code — CodeEntry would only dead-end at ThpPairingCodeRequired, so the
    // opted-in SkipPairing path is chosen instead.
    expect(selectThpPairingMethod([ThpPairingMethod.CodeEntry, ThpPairingMethod.SkipPairing], true, false)).toBe(
      ThpPairingMethod.SkipPairing,
    )
  })

  it('refuses (null) when CodeEntry is the only method but no pairing-code callback exists', () => {
    // No callback → CodeEntry unusable; SkipPairing not offered → refuse rather
    // than prompt the device for a flow that cannot complete.
    expect(selectThpPairingMethod([ThpPairingMethod.CodeEntry], false, false)).toBeNull()
    // Even with SkipPairing allowed, if the device doesn't offer it we still refuse.
    expect(selectThpPairingMethod([ThpPairingMethod.CodeEntry], true, false)).toBeNull()
  })

  it('still prefers a runnable CodeEntry over an opted-in SkipPairing', () => {
    expect(selectThpPairingMethod([ThpPairingMethod.CodeEntry, ThpPairingMethod.SkipPairing], true, true)).toBe(
      ThpPairingMethod.CodeEntry,
    )
  })
})
