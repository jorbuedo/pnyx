import {describe, expect, it} from 'vitest'
import {isTrezorUsbDevice, toDetectedUsbTrezors, trezorUsbDeviceName} from './trezor-usb-devices'

const T1 = {vendorId: 0x534c, productId: 0x0001}
const SAFE = {vendorId: 0x1209, productId: 0x53c1}
const BOOTLOADER = {vendorId: 0x1209, productId: 0x53c0}

describe('isTrezorUsbDevice', () => {
  it('accepts every descriptor the transport supports', () => {
    expect(isTrezorUsbDevice(T1)).toBe(true)
    expect(isTrezorUsbDevice(SAFE)).toBe(true)
    expect(isTrezorUsbDevice(BOOTLOADER)).toBe(true)
  })

  it('rejects unrelated devices on the bus', () => {
    // A USB hub and an Android phone in accessory mode both show up in deviceList.
    expect(isTrezorUsbDevice({vendorId: 0x05e3, productId: 0x0608})).toBe(false)
    expect(isTrezorUsbDevice({vendorId: 0x18d1, productId: 0x4ee1})).toBe(false)
  })

  it('does not match a Trezor vendor id paired with a foreign product id', () => {
    expect(isTrezorUsbDevice({vendorId: 0x1209, productId: 0x0001})).toBe(false)
    expect(isTrezorUsbDevice({vendorId: 0x534c, productId: 0x53c1})).toBe(false)
  })
})

describe('trezorUsbDeviceName', () => {
  it('prefers the name the device reports', () => {
    expect(trezorUsbDeviceName({...SAFE, deviceName: '/dev/bus/usb/001/002', productName: 'Trezor Safe 5'})).toBe(
      'Trezor Safe 5',
    )
  })

  it('falls back to the descriptor meaning when Android reports no product name', () => {
    // Android returns a null productName for a device held without permission —
    // the row still has to render, which is the whole point of the fallback.
    expect(trezorUsbDeviceName({...T1, deviceName: 'p'})).toBe('Trezor One')
    expect(trezorUsbDeviceName({...BOOTLOADER, deviceName: 'p'})).toBe('Trezor (Bootloader)')
    expect(trezorUsbDeviceName({...SAFE, deviceName: 'p'})).toBe('Trezor')
  })

  it('treats a whitespace-only product name as absent', () => {
    expect(trezorUsbDeviceName({...T1, deviceName: 'p', productName: '   '})).toBe('Trezor One')
  })
})

describe('toDetectedUsbTrezors', () => {
  it('keeps only Trezors and carries the permission flag through', () => {
    const detected = toDetectedUsbTrezors([
      {...SAFE, deviceName: '/dev/bus/usb/001/003', productName: 'Trezor Safe 5', hasPermission: true},
      {vendorId: 0x05e3, productId: 0x0608, deviceName: '/dev/bus/usb/001/001', productName: 'USB Hub'},
      {...T1, deviceName: '/dev/bus/usb/001/004'},
    ])

    expect(detected).toEqual([
      {deviceName: '/dev/bus/usb/001/003', name: 'Trezor Safe 5', hasPermission: true},
      {deviceName: '/dev/bus/usb/001/004', name: 'Trezor One', hasPermission: false},
    ])
  })

  it('reports a missing permission flag as not-permitted rather than assuming access', () => {
    const [device] = toDetectedUsbTrezors([{...SAFE, deviceName: 'p'}])
    expect(device?.hasPermission).toBe(false)
  })

  it('returns nothing when the bus holds no Trezor', () => {
    expect(toDetectedUsbTrezors([{vendorId: 0x05e3, productId: 0x0608, deviceName: 'p'}])).toEqual([])
  })
})
