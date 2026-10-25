/**
 * Transport/protocol type definitions.
 *
 * Replaces types from @trezor/transport/lib/types and @trezor/protocol.
 *
 * @module
 */

/**
 * Branded string types for path and session identifiers.
 * Provides type safety without runtime overhead.
 */
export type PathInternal = string & {__type: 'PathInternal'}
export type PathPublic = string & {__type: 'PathPublic'}
export type Session = string & {__type: 'Session'}

export const PathInternal = (value: string): PathInternal => value as PathInternal
export const PathPublic = (value: string): PathPublic => value as PathPublic
export const Session = (value: string): Session => value as Session

/**
 * API type identifier for the transport medium.
 */
export type ApiType = 'usb' | 'bluetooth' | 'node-bridge'

/**
 * Descriptor at the raw API level (from enumerate).
 */
export type DescriptorApiLevel = {
  path: string
  product?: number
  vendor?: number
  type?: number
  apiType?: ApiType
}

/**
 * Descriptor with session info (after session management).
 */
export type Descriptor = DescriptorApiLevel & {
  session: Session | null
  sessionOwner?: string
}

/**
 * Logger interface for transport operations.
 */
export type Logger = {
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * Decoded protocol message.
 */
export type DecodedProtocolMessage = {
  header: Uint8Array
  length: number
  messageType: number
  payload: Uint8Array
}
