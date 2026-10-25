/**
 * Ledger transport type definitions and utilities.
 *
 * Platform-specific transports are in separate files:
 * - transports-web.ts for WebHID/WebUSB (browser/extension)
 * - transports-native.ts for BLE/USB HID (React Native)
 *
 * Import platform-specific transports from:
 * - ./index.js/ledger-web
 * - ./index.js/ledger-native
 *
 * @module
 */

// Re-export types for convenience
export type {LedgerTransport, LedgerTransportFactory} from './types'

/**
 * Transport module shape for dynamic imports.
 */
export type TransportModule = {
  default: {
    create?: () => Promise<unknown>
    open: (descriptor: unknown) => Promise<unknown>
    list?: () => Promise<readonly unknown[]>
    listen: (observer: {
      next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
      error: (error: Error) => void
      complete: () => void
    }) => {unsubscribe: () => void}
  }
}

/**
 * Checks if running in a browser environment.
 */
export const isBrowser = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined'

/**
 * Checks if running in Node.js environment.
 */
export const isNode = (): boolean =>
  typeof process !== 'undefined' && process.versions != null && process.versions.node != null

/**
 * Checks if running in React Native environment.
 */
export const isReactNative = (): boolean => typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
