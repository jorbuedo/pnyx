import {describe, expect, it} from 'vitest'
import {decodeLedgerUsbId, encodeLedgerUsbId, isLedgerUsbId} from './ledger-usb-device'

// Ledger's USB vendor id, and the Nano X product id.
const NANO_X = {vendorId: 0x2c97, productId: 0x4011}

describe('Ledger USB id round-trip', () => {
  it('recovers the exact vendor/product pair', () => {
    expect(decodeLedgerUsbId(encodeLedgerUsbId(NANO_X))).toEqual(NANO_X)
  })

  it('round-trips a zero product id', () => {
    expect(decodeLedgerUsbId(encodeLedgerUsbId({vendorId: 0x2c97, productId: 0}))).toEqual({
      vendorId: 0x2c97,
      productId: 0,
    })
  })
})

describe('decodeLedgerUsbId', () => {
  it('rejects ids belonging to other transports', () => {
    // A Trezor USB row carries an Android device path; a BLE row a peripheral id.
    expect(decodeLedgerUsbId('/dev/bus/usb/001/003')).toBeNull()
    expect(decodeLedgerUsbId('C7:9F:1A:2B:3C:4D')).toBeNull()
    expect(decodeLedgerUsbId('')).toBeNull()
  })

  it('rejects a wrong prefix even when the shape matches', () => {
    expect(decodeLedgerUsbId('trezor-usb:11415:16401')).toBeNull()
  })

  it('rejects non-numeric segments instead of coercing them', () => {
    expect(decodeLedgerUsbId('ledger-usb:abc:16401')).toBeNull()
    expect(decodeLedgerUsbId('ledger-usb:11415:xyz')).toBeNull()
  })

  it('rejects empty segments rather than reading them as 0', () => {
    // Number('') === 0 and is an integer — without the length guard this would
    // decode to vendorId 0 and open the wrong device.
    expect(decodeLedgerUsbId('ledger-usb::16401')).toBeNull()
    expect(decodeLedgerUsbId('ledger-usb:11415:')).toBeNull()
  })

  it('rejects a fractional id', () => {
    expect(decodeLedgerUsbId('ledger-usb:11415.5:16401')).toBeNull()
  })

  it('rejects the wrong segment count', () => {
    expect(decodeLedgerUsbId('ledger-usb:11415')).toBeNull()
    expect(decodeLedgerUsbId('ledger-usb:11415:16401:extra')).toBeNull()
  })
})

describe('isLedgerUsbId', () => {
  it('distinguishes a Ledger USB handle from other ids', () => {
    expect(isLedgerUsbId(encodeLedgerUsbId(NANO_X))).toBe(true)
    expect(isLedgerUsbId('/dev/bus/usb/001/003')).toBe(false)
  })
})
