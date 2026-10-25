/**
 * Covers `trezorReconnectTransports` — which transport a Trezor reconnect opens.
 *
 * The field it decides is `TrezorConfig.transports`, and an absent value is not
 * neutral: `connectTrezor` reads it as "auto-detect", whose Android arm tries
 * USB before BLE. A BLE-paired Trezor therefore enumerated USB on the first
 * hardware operation after launch (the only knowledge of the pairing that
 * survives a launch is `transportHint` / `bleDeviceId`, and this is what makes
 * the reconnect state it) and failed with "No Trezor devices found" while the
 * device sat connected over the radio.
 */

import {describe, expect, it} from 'vitest'
import {trezorReconnectTransports} from './hardware-wallet-service'

describe('trezorReconnectTransports', () => {
  it('pins BLE when the stored hint says the device was paired over the radio', () => {
    expect(trezorReconnectTransports({configured: undefined, transportHint: 'ble', hasBleDeviceId: false})).toEqual([
      'NativeBluetoothTransport',
    ])
  })

  it('pins BLE on a stored device id even when the hint is missing', () => {
    // Legacy credential records predate `transportHint`; a stored peripheral id
    // is still positive proof the pairing was BLE.
    expect(trezorReconnectTransports({configured: undefined, transportHint: null, hasBleDeviceId: true})).toEqual([
      'NativeBluetoothTransport',
    ])
  })

  it('leaves a USB-hinted device on auto-detect', () => {
    // Auto-detect's per-platform order is already right for a cable, and
    // pinning USB would send an iOS device down a transport it has no USB for.
    expect(
      trezorReconnectTransports({configured: undefined, transportHint: 'usb', hasBleDeviceId: false}),
    ).toBeUndefined()
  })

  it('leaves auto-detect alone when nothing is known about the pairing', () => {
    expect(
      trezorReconnectTransports({configured: undefined, transportHint: null, hasBleDeviceId: false}),
    ).toBeUndefined()
  })

  it("keeps a caller's own filter, including one that disagrees with the hint", () => {
    // `['BridgeTransport']` is how the emulator harness reaches a device that
    // has neither radio nor cable. Overriding it would break that rail.
    const configured = ['BridgeTransport']
    expect(trezorReconnectTransports({configured, transportHint: 'ble', hasBleDeviceId: true})).toBe(configured)
  })

  it('keeps an explicitly empty filter rather than substituting BLE', () => {
    // An empty list means the caller has decided no transport applies, and
    // `connectTrezor` fails with that. Filling it in would be inventing one.
    const configured: readonly string[] = []
    expect(trezorReconnectTransports({configured, transportHint: 'ble', hasBleDeviceId: true})).toBe(configured)
  })
})
