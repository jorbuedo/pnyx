import {describe, expect, it} from 'vitest'
import {resolveDeviceDisplayName} from './device-display-name'

describe('resolveDeviceDisplayName', () => {
  it('prefers the label the device reports over the discovery name', () => {
    // The USB case this exists for: the string descriptor is a fixed vendor
    // string, so discovery can only offer "Trezor".
    expect(resolveDeviceDisplayName({scanName: 'Trezor', deviceLabel: "Jordi's Safe 7"})).toBe("Jordi's Safe 7")
  })

  it('keeps the discovery name when the device has no label', () => {
    expect(resolveDeviceDisplayName({scanName: 'Trezor Safe 5', deviceLabel: undefined})).toBe('Trezor Safe 5')
    expect(resolveDeviceDisplayName({scanName: 'Trezor Safe 5', deviceLabel: null})).toBe('Trezor Safe 5')
  })

  it('treats a blank label as absent rather than blanking the name', () => {
    expect(resolveDeviceDisplayName({scanName: 'Trezor One', deviceLabel: '   '})).toBe('Trezor One')
    expect(resolveDeviceDisplayName({scanName: 'Trezor One', deviceLabel: ''})).toBe('Trezor One')
  })

  it('trims both sides', () => {
    expect(resolveDeviceDisplayName({scanName: '  Trezor  ', deviceLabel: '  My Device  '})).toBe('My Device')
    expect(resolveDeviceDisplayName({scanName: '  Trezor  '})).toBe('Trezor')
  })

  it('does not invent a name when neither side has one', () => {
    // Caller owns the generic fallback (`hardware.defaultName`); this must not
    // quietly supply one.
    expect(resolveDeviceDisplayName({scanName: '', deviceLabel: ''})).toBe('')
  })
})
