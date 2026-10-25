/**
 * @pnyx/storage
 *
 * Storage abstraction for white-label wallet applications.
 *
 * This package provides a unified storage interface that works across
 * all platforms (React Native, browser, browser extension, Node.js).
 *
 * @example
 * ```ts
 * import {Storage, MemoryStorageLayer, getJson, setJson} from '@pnyx/storage'
 * import {Effect} from 'effect'
 *
 * // Using the storage service
 * const program = Effect.gen(function* () {
 *   const storage = yield* Storage
 *
 *   // Simple string storage
 *   yield* storage.set('key', 'value')
 *   const value = yield* storage.get('key')
 *
 *   // JSON storage with type safety
 *   yield* setJson('user', {name: 'Alice', age: 30})
 *   const user = yield* getJson<{name: string; age: number}>('user')
 * })
 *
 * // Run with in-memory storage (for testing)
 * Effect.runPromise(Effect.provide(program, MemoryStorageLayer))
 * ```
 *
 * @module
 */

// Browser extension storage
export {
  type BrowserStorageApi,
  createBrowserExtensionStorage,
  createBrowserExtensionStorageLayer,
} from './browser-extension.js'

// JSON utilities
export {getJson, getJsonWithDefault, setJson, updateJson} from './json.js'

// Memory storage
export {createMemoryStorage, MemoryStorageLayer} from './memory.js'
// MMKV storage (React Native)
export {createMMKVStorage, createMMKVStorageLayer, MMKVStorageLayer} from './mmkv.js'
// Platform detection and auto-selection
export {
  createPlatformStorage,
  createPlatformStorageEffect,
  detectPlatform,
  isBrowser,
  isBrowserExtension,
  isNode,
  isReactNative,
  PlatformStorageLayer,
  PlatformStorageLayerEffect,
} from './platform.js'
// Key-prefix decorator (profile namespacing)
export {createPrefixedStorage} from './prefixed.js'
export type {Platform, Storage as StorageService} from './types.js'
// Types
export {
  Storage,
  StorageError,
  StorageKeyNotFoundError,
  StorageSerializationError,
} from './types.js'
// Web storage
export {createWebStorage, WebStorageLayer} from './web.js'
