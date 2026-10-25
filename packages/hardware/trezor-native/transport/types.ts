/**
 * Transport layer types for native Trezor transports.
 *
 * Defines the DeviceApi interface that replaces @trezor/transport's AbstractApi class,
 * plus result types and re-exports of transport types.
 *
 * @module
 */

import type * as ERRORS from '../../trezor-protocol/errors'
import type {
  ApiType,
  Descriptor,
  DescriptorApiLevel,
  Logger,
  PathInternal,
  PathPublic,
  Session,
} from '../../trezor-protocol/types'

export type {ApiType, Descriptor, DescriptorApiLevel, Logger, PathInternal, PathPublic, Session}

/**
 * Common params for creating a native transport (USB or Bluetooth).
 */
export type TransportParams = {
  readonly logger?: Logger
  readonly messages?: import('protobufjs').INamespace
  readonly id?: string
}

/**
 * Successful result.
 */
export type Success<T> = {
  readonly success: true
  readonly payload: T
}

/**
 * Error result matching transport error shape.
 */
export type ErrorResult<E extends string = string> = {
  readonly success: false
  readonly error: E
  readonly message?: string | undefined
}

/**
 * Result type.
 */
export type TrezorResult<T, E extends string = string> = Success<T> | ErrorResult<E>

/**
 * Channel types for opening device connections.
 */
export type OpenDeviceChannel = 'read' | 'trezor-push-notification' | 'battery-level'

/**
 * Options for opening a device.
 */
export type OpenDeviceOptions = {
  readonly reset?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly channel?: OpenDeviceChannel | undefined
}

/**
 * Options for closing a device.
 */
export type CloseDeviceOptions = {
  readonly channel?: OpenDeviceChannel | undefined
}

/**
 * Device API interface — functional replacement for AbstractApi.
 *
 * Provides enumerate, read, write, and device lifecycle methods
 * for a specific transport medium (USB or Bluetooth).
 */
export type DeviceApi = {
  readonly type: ApiType
  readonly chunkSize: number
  readonly enumerate: (
    signal?: AbortSignal,
  ) => Promise<
    TrezorResult<
      DescriptorApiLevel[],
      typeof ERRORS.DEVICE_NOT_FOUND | typeof ERRORS.UNEXPECTED_ERROR | typeof ERRORS.ABORTED_BY_SIGNAL
    >
  >
  readonly listen: () => void
  readonly read: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<
    TrezorResult<
      Uint8Array,
      | typeof ERRORS.DEVICE_NOT_FOUND
      | typeof ERRORS.INTERFACE_UNABLE_TO_OPEN_DEVICE
      | typeof ERRORS.INTERFACE_DATA_TRANSFER
      | typeof ERRORS.DEVICE_DISCONNECTED_DURING_ACTION
      | typeof ERRORS.UNEXPECTED_ERROR
      | typeof ERRORS.ABORTED_BY_SIGNAL
      | typeof ERRORS.ABORTED_BY_TIMEOUT
    >
  >
  readonly write: (
    path: string,
    buffer: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<
    TrezorResult<
      undefined,
      | typeof ERRORS.DEVICE_NOT_FOUND
      | typeof ERRORS.INTERFACE_DATA_TRANSFER
      | typeof ERRORS.DEVICE_DISCONNECTED_DURING_ACTION
      | typeof ERRORS.UNEXPECTED_ERROR
      | typeof ERRORS.ABORTED_BY_SIGNAL
      | typeof ERRORS.ABORTED_BY_TIMEOUT
    >
  >
  readonly openDevice: (path: string, options?: OpenDeviceOptions) => Promise<TrezorResult<undefined>>
  readonly closeDevice: (path: string, options?: CloseDeviceOptions) => Promise<TrezorResult<undefined>>
  readonly dispose: () => void
  readonly on: (event: string, listener: (...args: unknown[]) => void) => void
  readonly off: (event: string, listener: (...args: unknown[]) => void) => void
  readonly once: (event: string, listener: (...args: unknown[]) => void) => void
  readonly emit: (event: string, ...args: unknown[]) => void
}

/**
 * Helper to create a success result.
 */
export const success = <T>(payload: T): Success<T> => ({success: true, payload})

/**
 * Helper to create an error result.
 */
export const error = <E extends string>(err: E, message?: string): ErrorResult<E> => ({
  success: false,
  error: err,
  message,
})

/**
 * Map an unknown error to the appropriate error result.
 */
export const unknownError = (err: unknown, expectedErrors: string[] = []): ErrorResult => {
  const msg = err instanceof Error ? err.message : String(err)
  const expectedErr = expectedErrors.find((e) => e === msg)
  if (expectedErr) {
    return error(expectedErr)
  }
  return error('unexpected error', msg)
}
