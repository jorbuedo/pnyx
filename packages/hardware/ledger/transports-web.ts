/**
 * Web-specific Ledger transport factories.
 *
 * Provides WebHID and WebUSB transport creation for browser environments.
 * This file should only be imported in web/extension builds.
 *
 * @module
 */

import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import {getLogger} from '@pnyx/logger'
import {Effect} from 'effect'
import {TransportError} from '../types'
import type {LedgerTransport, LedgerTransportFactory} from './types'

const logger = getLogger('hardware')

import {findAuthorizedLedgerDevice} from './webhid-reacquire'

type WebHidLike = {getDevices: () => Promise<ReadonlyArray<{vendorId: number}>>}

const getWebHid = (): WebHidLike | undefined =>
  typeof navigator !== 'undefined' ? (navigator as Navigator & {hid?: WebHidLike}).hid : undefined

/**
 * Open an already-authorized HIDDevice, recovering from "The device is already
 * open." A discarded transport (e.g. one abandoned across a Nano S
 * re-enumeration) can leave the HIDDevice open; `TransportWebHID.open` calls
 * `device.open()` unconditionally and throws. Close the stale handle and retry.
 */
const openHidDeviceWithRetry = async (device: {open?: () => Promise<void>; close?: () => Promise<void>}) => {
  try {
    return await (TransportWebHID.open(
      device as Parameters<typeof TransportWebHID.open>[0],
    ) as Promise<LedgerTransport>)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already open/i.test(message) || typeof device.close !== 'function') throw error
    await device.close().catch((e) => {
      logger.warn('Closing an already-open HID device failed; reopening anyway', {
        origin: 'LedgerTransportsWeb',
        error: String(e),
      })
    })
    return (await TransportWebHID.open(device as Parameters<typeof TransportWebHID.open>[0])) as LedgerTransport
  }
}

/**
 * Open an already-authorized Ledger without a user gesture when one is present,
 * falling back to the gesture-gated picker only when none is found. A Nano S
 * re-enumerates USB on app switch, so a programmatic reconnect must reopen the
 * device via `open()` (no gesture) rather than `create()`'s `requestDevice()`.
 */
const openOrCreateWebHIDTransport = async (): Promise<LedgerTransport> => {
  const authorized = await findAuthorizedLedgerDevice(getWebHid(), {
    timeoutMs: 2500,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  })
  if (authorized) {
    return openHidDeviceWithRetry(authorized as {open?: () => Promise<void>; close?: () => Promise<void>})
  }
  return TransportWebHID.create() as Promise<LedgerTransport>
}

/**
 * Creates a WebHID transport factory for Ledger devices.
 *
 * Requires `@ledgerhq/hw-transport-webhid` to be installed.
 *
 * @returns Effect that resolves to a transport factory
 */
export const createWebHIDTransportFactory = (): Effect.Effect<LedgerTransportFactory, TransportError> =>
  Effect.try({
    try: () => ({
      create: async () => openOrCreateWebHIDTransport(),
      open: async (descriptor: unknown) =>
        TransportWebHID.open(descriptor as Parameters<typeof TransportWebHID.open>[0]) as Promise<LedgerTransport>,
      list: async () => TransportWebHID.list(),
      listen: (observer: {
        next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
        error: (error: unknown) => void
        complete: () => void
      }) => TransportWebHID.listen(observer as Parameters<typeof TransportWebHID.listen>[0]),
    }),
    catch: (error) =>
      new TransportError({
        transportType: 'webhid',
        message: `Failed to create WebHID transport: ${error instanceof Error ? error.message : String(error)}. Ensure @ledgerhq/hw-transport-webhid is installed.`,
        cause: error,
      }),
  })

/**
 * Creates a WebHID transport directly.
 *
 * @returns Effect that resolves to a connected transport
 */
export const createWebHIDTransport = (): Effect.Effect<LedgerTransport, TransportError> =>
  Effect.gen(function* () {
    const factory = yield* createWebHIDTransportFactory()
    return yield* Effect.tryPromise({
      try: () => factory.create(),
      catch: (error) =>
        new TransportError({
          transportType: 'webhid',
          message: `Failed to connect via WebHID: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })
  })

/**
 * Creates a WebUSB transport factory for Ledger devices.
 *
 * Requires `@ledgerhq/hw-transport-webusb` to be installed.
 * This is a fallback for browsers that don't support WebHID.
 *
 * @returns Effect that resolves to a transport factory
 */
export const createWebUSBTransportFactory = (): Effect.Effect<LedgerTransportFactory, TransportError> =>
  Effect.try({
    try: () => ({
      create: async () => TransportWebUSB.create() as Promise<LedgerTransport>,
      open: async (descriptor: unknown) =>
        TransportWebUSB.open(descriptor as Parameters<typeof TransportWebUSB.open>[0]) as Promise<LedgerTransport>,
      list: async () => TransportWebUSB.list(),
      listen: (observer: {
        next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
        error: (error: unknown) => void
        complete: () => void
      }) => TransportWebUSB.listen(observer as Parameters<typeof TransportWebUSB.listen>[0]),
    }),
    catch: (error) =>
      new TransportError({
        transportType: 'webusb',
        message: `Failed to create WebUSB transport: ${error instanceof Error ? error.message : String(error)}. Ensure @ledgerhq/hw-transport-webusb is installed.`,
        cause: error,
      }),
  })

/**
 * Creates a WebUSB transport directly.
 *
 * @returns Effect that resolves to a connected transport
 */
export const createWebUSBTransport = (): Effect.Effect<LedgerTransport, TransportError> =>
  Effect.gen(function* () {
    const factory = yield* createWebUSBTransportFactory()
    return yield* Effect.tryPromise({
      try: () => factory.create(),
      catch: (error) =>
        new TransportError({
          transportType: 'webusb',
          message: `Failed to connect via WebUSB: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })
  })

/**
 * Checks if WebHID is available.
 */
export const hasWebHID = (): boolean => typeof navigator !== 'undefined' && 'hid' in navigator

/**
 * Checks if WebUSB is available.
 */
export const hasWebUSB = (): boolean => typeof navigator !== 'undefined' && 'usb' in navigator

/**
 * Detects the best available web transport.
 *
 * @returns Effect that resolves to the best available transport factory
 */
export const detectBestWebTransportFactory = (): Effect.Effect<LedgerTransportFactory, TransportError> =>
  Effect.gen(function* () {
    if (hasWebHID()) {
      return yield* createWebHIDTransportFactory()
    }

    if (hasWebUSB()) {
      return yield* createWebUSBTransportFactory()
    }

    return yield* Effect.fail(
      new TransportError({
        transportType: 'usb',
        message: 'No compatible web transport available. Ensure WebHID or WebUSB is supported in the browser.',
      }),
    )
  })
