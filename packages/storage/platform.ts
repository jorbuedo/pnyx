/**
 * Platform detection utilities and PlatformStorageLayer.
 *
 * This is the non-React Native version. For React Native, the bundler
 * will use platform.native.ts instead via conditional exports.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import {createBrowserExtensionStorage} from './browser-extension.js'
import {createMemoryStorage} from './memory.js'
import type {Platform, Storage} from './types.js'
import {Storage as StorageTag} from './types.js'
import {createWebStorage} from './web.js'

// Declare global types for platform detection
declare const chrome:
  | {
      runtime?: {id?: string}
      storage?: {
        local: {
          get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
          set: (items: Record<string, unknown>) => Promise<void>
          remove: (keys: string | string[]) => Promise<void>
          clear: () => Promise<void>
        }
      }
    }
  | undefined
declare const process: {versions?: {node?: string; bun?: string}} | undefined

/**
 * Detects the current platform.
 *
 * @returns Detected platform type
 */
export const detectPlatform = (): Platform => {
  // Check for browser extension (Chrome/Firefox)
  // biome-ignore lint/complexity/useOptionalChain: typeof check prevents ReferenceError
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
    return 'browser-extension'
  }

  // Check for browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return 'browser'
  }

  // Check for Node.js or Bun
  if (typeof process !== 'undefined' && (process?.versions?.node || process?.versions?.bun)) {
    return 'node'
  }

  return 'unknown'
}

/**
 * Checks if running in React Native environment.
 */
export const isReactNative = (): boolean => false

/**
 * Checks if running in browser environment.
 */
export const isBrowser = (): boolean => detectPlatform() === 'browser'

/**
 * Checks if running in browser extension environment.
 */
export const isBrowserExtension = (): boolean => detectPlatform() === 'browser-extension'

/**
 * Checks if running in Node.js environment.
 */
export const isNode = (): boolean => detectPlatform() === 'node'

/**
 * Create platform-specific storage (sync version).
 *
 * Automatically selects the correct implementation based on platform:
 * - Browser extension: chrome.storage.local
 * - Web: localStorage
 * - Node.js: Memory storage
 */
export const createPlatformStorage = (): Storage => {
  const platform = detectPlatform()
  switch (platform) {
    case 'browser-extension':
      // biome-ignore lint/complexity/useOptionalChain: typeof check prevents ReferenceError
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        return createBrowserExtensionStorage(chrome.storage.local)
      }
      // Fallback to web storage if chrome.storage not available
      return createWebStorage()
    case 'node':
      return createMemoryStorage()
    default:
      return createWebStorage()
  }
}

/**
 * Create platform-specific storage (Effect version).
 *
 * Automatically selects the best implementation based on platform:
 * - Browser extension: chrome.storage.local
 * - Web: localStorage
 * - Node.js: Memory storage (for testing/SSR)
 */
export const createPlatformStorageEffect = (): Effect.Effect<Storage, never> => {
  const platform = detectPlatform()

  switch (platform) {
    case 'browser-extension':
      return Effect.sync(() => {
        // biome-ignore lint/complexity/useOptionalChain: typeof check prevents ReferenceError
        if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
          return createBrowserExtensionStorage(chrome.storage.local)
        }
        return createWebStorage()
      })

    case 'node':
      // Use memory storage for Node.js (SSR/testing)
      return Effect.sync(() => createMemoryStorage())

    default:
      return Effect.sync(() => createWebStorage())
  }
}

/**
 * Platform-aware storage layer (sync version).
 *
 * Automatically selects the correct storage implementation:
 * - Browser extension: chrome.storage.local
 * - Web: localStorage
 * - Node.js: Memory storage
 */
export const PlatformStorageLayer: Layer.Layer<Storage> = Layer.sync(StorageTag, createPlatformStorage)

/**
 * Platform-aware storage layer (Effect version).
 *
 * Automatically selects the best storage implementation:
 * - Browser extension: chrome.storage.local
 * - Web: localStorage
 * - Node.js: Memory storage
 */
export const PlatformStorageLayerEffect: Layer.Layer<Storage> = Layer.effect(StorageTag, createPlatformStorageEffect())
