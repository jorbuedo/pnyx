/**
 * Platform detection and automatic store selection.
 *
 * This is the non-React Native version. For React Native, the bundler
 * will use platform.native.ts instead via conditional exports.
 *
 * Automatically selects the best storage backend based on platform:
 * - Browser / extension service worker: IndexedDB
 * - Node.js/Bun: better-sqlite3
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import {StoreError} from './errors.js'
import {MemoryStore, type Store, StoreService} from './store.js'

/**
 * Supported platform types.
 */
export type StorePlatform = 'react-native' | 'browser' | 'node'

// Declare globals for platform detection
declare const indexedDB: unknown | undefined
declare const process: {versions?: {node?: string; bun?: string}} | undefined

/**
 * Detect the current platform for store selection.
 */
export const detectPlatform = (): StorePlatform => {
  // `indexedDB` is a global in windows AND worker / extension service-worker
  // scopes (where `window` is absent), so detect on it directly.
  if (typeof indexedDB !== 'undefined') {
    return 'browser'
  }

  // Check for Node.js or Bun
  if (typeof process !== 'undefined' && (process.versions?.node || process.versions?.bun)) {
    return 'node'
  }

  // Default to node (safest for server environments)
  return 'node'
}

/**
 * Check if running on React Native.
 */
export const isReactNative = (): boolean => false

/**
 * Check if running in browser.
 */
export const isBrowser = (): boolean => detectPlatform() === 'browser'

/**
 * Check if running on Node.js or Bun.
 */
export const isNode = (): boolean => detectPlatform() === 'node'

/**
 * Create platform-specific store.
 *
 * Automatically selects the best storage backend:
 * - Browser: IndexedDB
 * - Node.js/Bun: better-sqlite3
 *
 * Falls back to memory store if the preferred backend is unavailable.
 *
 * @param dbName - Database name (default: 'pnyx')
 */
export const createPlatformStore = (dbName = 'pnyx'): Effect.Effect<Store, never> =>
  Effect.gen(function* () {
    const platform = detectPlatform()

    const storeResult = yield* Effect.gen(function* () {
      switch (platform) {
        case 'browser': {
          const {IndexedDBStore} = yield* Effect.tryPromise({
            try: () => import('./indexeddb.js'),
            catch: (e) => new StoreError({message: `Failed to import IndexedDB store: ${e}`, cause: e}),
          })
          return yield* IndexedDBStore(dbName)
        }

        case 'node': {
          const {BetterSqlite3Store} = yield* Effect.tryPromise({
            try: () => import('./better-sqlite3.js'),
            catch: (e) => new StoreError({message: `Failed to import better-sqlite3 store: ${e}`, cause: e}),
          })
          return yield* BetterSqlite3Store(`${dbName}.db`)
        }

        default:
          return yield* MemoryStore
      }
    }).pipe(
      Effect.catchAll((e) => {
        // Log the error and fall back to memory store
        console.warn(`[Store] Failed to create platform store, falling back to memory: ${e}`)
        return MemoryStore
      }),
    )

    return storeResult
  })

/**
 * Platform store layer for dependency injection.
 *
 * Automatically provides the correct store implementation
 * based on the current platform.
 */
export const PlatformStoreLayer = Layer.effect(StoreService, createPlatformStore())

/**
 * Create platform store layer with custom database name.
 */
export const createPlatformStoreLayer = (dbName: string) => Layer.effect(StoreService, createPlatformStore(dbName))
