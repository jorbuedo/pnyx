/**
 * React Native-specific Ledger transport factories.
 *
 * Provides Bluetooth (BLE) and USB HID transport creation for mobile.
 * This file should only be imported in React Native builds.
 *
 * @module
 */

import TransportHID from '@ledgerhq/react-native-hid'
import TransportBLE from '@ledgerhq/react-native-hw-transport-ble'
import {Effect} from 'effect'
import {TransportError} from '../types'
import type {LedgerTransport, LedgerTransportFactory} from './types'

/**
 * Creates a React Native Bluetooth transport factory for Ledger devices.
 *
 * Requires `@ledgerhq/react-native-hw-transport-ble` to be installed.
 * Only works in React Native environments.
 *
 * @returns Effect that resolves to a transport factory
 */
export const createBLETransportFactory = (): Effect.Effect<LedgerTransportFactory, TransportError> =>
  Effect.try({
    try: () => ({
      create: async () => {
        // BLE requires scanning for devices first
        throw new Error('BLE transport requires explicit device selection via open()')
      },
      open: async (descriptor: unknown) => TransportBLE.open(descriptor as string) as Promise<LedgerTransport>,
      list: async () => {
        // BLE doesn't have a sync list, returns empty
        return [] as readonly unknown[]
      },
      listen: (observer: {
        next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
        error: (error: Error) => void
        complete: () => void
      }) => TransportBLE.listen(observer),
      forceBleDisconnect: async (id: string) => {
        // biome-ignore lint/suspicious/noExplicitAny: SDK static, types omit it on some builds
        const fn = (TransportBLE as any).disconnectDevice
        if (typeof fn !== 'function') return
        await fn.call(TransportBLE, id)
      },
    }),
    catch: (error) =>
      new TransportError({
        transportType: 'bluetooth',
        message: `Failed to create BLE transport: ${error instanceof Error ? error.message : String(error)}. Ensure @ledgerhq/react-native-hw-transport-ble is installed and running in React Native.`,
        cause: error,
      }),
  })

/**
 * Opens a Bluetooth connection to a specific Ledger device.
 *
 * @param deviceId - BLE device ID from scanning
 * @returns Effect that resolves to a connected transport
 */
export const openBLETransport = (deviceId: string): Effect.Effect<LedgerTransport, TransportError> =>
  Effect.gen(function* () {
    const factory = yield* createBLETransportFactory()
    if (!factory.open) {
      return yield* Effect.fail(
        new TransportError({
          transportType: 'bluetooth',
          message: 'BLE transport factory does not support open()',
        }),
      )
    }
    const openFn = factory.open
    return yield* Effect.tryPromise({
      try: () => openFn(deviceId),
      catch: (error) =>
        new TransportError({
          transportType: 'bluetooth',
          message: `Failed to connect via BLE: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })
  })

/**
 * Creates a React Native USB HID transport factory for Ledger devices.
 *
 * Requires `@ledgerhq/react-native-hid` to be installed.
 * Only works on Android.
 *
 * @returns Effect that resolves to a transport factory
 */
export const createUSBHIDTransportFactory = (): Effect.Effect<LedgerTransportFactory, TransportError> =>
  Effect.try({
    try: () => ({
      create: async () => {
        // USB HID typically requires explicit device selection
        throw new Error('USB HID transport requires explicit device selection via open()')
      },
      open: async (descriptor: unknown) =>
        TransportHID.open(descriptor as {vendorId: number; productId: number}) as Promise<LedgerTransport>,
      list: TransportHID.list ? async () => TransportHID.list?.() ?? [] : async () => [] as readonly unknown[],
      listen: (observer: {
        next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
        error: (error: Error) => void
        complete: () => void
      }) => TransportHID.listen(observer),
    }),
    catch: (error) =>
      new TransportError({
        transportType: 'usb',
        message: `Failed to create USB HID transport: ${error instanceof Error ? error.message : String(error)}. Ensure @ledgerhq/react-native-hid is installed and running on Android.`,
        cause: error,
      }),
  })

/**
 * Opens a USB HID connection to a specific Ledger device.
 *
 * @param descriptor - USB device descriptor from listing
 * @returns Effect that resolves to a connected transport
 */
export const openUSBHIDTransport = (descriptor: unknown): Effect.Effect<LedgerTransport, TransportError> =>
  Effect.gen(function* () {
    const factory = yield* createUSBHIDTransportFactory()
    if (!factory.open) {
      return yield* Effect.fail(
        new TransportError({
          transportType: 'usb',
          message: 'USB HID transport factory does not support open()',
        }),
      )
    }
    const openFn = factory.open
    return yield* Effect.tryPromise({
      try: () => openFn(descriptor),
      catch: (error) =>
        new TransportError({
          transportType: 'usb',
          message: `Failed to connect via USB HID: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })
  })
