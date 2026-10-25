/**
 * Covers `startUsbScan` — the glue that turns a platform USB hit into the
 * `DetectedDevice` the pair screen renders and `connect` routes on.
 *
 * Two fields are load-bearing. `transportType` decides USB vs BLE transport, so
 * a wrong value sends a cabled device down a radio path. `vendor` decides Trezor
 * vs Ledger; it exists because the first cut hardcoded `'trezor'`, which meant a
 * Ledger plugged in over USB was silently dropped from discovery.
 */

import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createHardwareWalletService} from './hardware-wallet-service'
import type {DetectedDevice, PlatformUsbScanFn} from './types'

const collectDevices = async (platformUsbScan?: PlatformUsbScanFn) => {
  const service = await Effect.runPromise(createHardwareWalletService(platformUsbScan ? {platformUsbScan} : {}))
  const seen: DetectedDevice[] = []
  const stop = await Effect.runPromise(service.startUsbScan((device) => seen.push(device)))
  return {seen, stop}
}

describe('startUsbScan', () => {
  it('maps a Trezor USB hit onto the usb transport', async () => {
    const {seen} = await collectDevices(({onDevice}) => {
      onDevice({id: '/dev/bus/usb/001/003', name: 'Trezor Safe 5', vendor: 'trezor'})
      return {unsubscribe: () => {}}
    })

    expect(seen).toEqual([{id: '/dev/bus/usb/001/003', name: 'Trezor Safe 5', type: 'trezor', transportType: 'usb'}])
  })

  it('maps a Ledger USB hit onto the usb transport', async () => {
    const {seen} = await collectDevices(({onDevice}) => {
      onDevice({id: 'ledger-usb:11415:16401', name: 'Nano X', vendor: 'ledger'})
      return {unsubscribe: () => {}}
    })

    expect(seen).toEqual([{id: 'ledger-usb:11415:16401', name: 'Nano X', type: 'ledger', transportType: 'usb'}])
  })

  it('carries the platform vendor through rather than assuming one', async () => {
    // The bug this pins: a hardcoded 'trezor' made a cabled Ledger unreachable.
    const {seen} = await collectDevices(({onDevice}) => {
      onDevice({id: 'a', name: 'Trezor One', vendor: 'trezor'})
      onDevice({id: 'ledger-usb:11415:20496', name: 'Stax', vendor: 'ledger'})
      return {unsubscribe: () => {}}
    })

    expect(seen.map((d) => d.type)).toEqual(['trezor', 'ledger'])
  })

  it('keeps the platform id verbatim so the transport can reopen that device', async () => {
    const {seen} = await collectDevices(({onDevice}) => {
      onDevice({id: '/dev/bus/usb/002/007', name: 'Trezor', vendor: 'trezor'})
      return {unsubscribe: () => {}}
    })

    expect(seen[0]?.id).toBe('/dev/bus/usb/002/007')
  })

  it('unsubscribes the platform scan when the returned stop is called', async () => {
    let stopped = false
    const {stop} = await collectDevices(() => ({
      unsubscribe: () => {
        stopped = true
      },
    }))

    expect(stopped).toBe(false)
    stop()
    expect(stopped).toBe(true)
  })

  it('yields nothing instead of failing when the platform has no USB host mode', async () => {
    // iOS and web reach this branch — discovery must degrade to BLE-only rather
    // than surfacing an error the pair screen would show as a scan failure.
    const {seen, stop} = await collectDevices()

    expect(seen).toEqual([])
    expect(() => stop()).not.toThrow()
  })
})
