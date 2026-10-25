/**
 * Platform store for React Native.
 *
 * Uses expo-sqlite for unlimited storage with proper SQL schema.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import {ExpoSQLiteStore} from './expo-sqlite.native.js'
import {MemoryStore, type Store, StoreService} from './store.js'

/**
 * Supported platform types.
 */
export type StorePlatform = 'react-native' | 'browser' | 'node'

/**
 * Detect the current platform for store selection.
 */
export const detectPlatform = (): StorePlatform => 'react-native'

/**
 * Check if running on React Native.
 */
export const isReactNative = (): boolean => true

/**
 * Check if running in browser.
 */
export const isBrowser = (): boolean => false

/**
 * Check if running on Node.js or Bun.
 */
export const isNode = (): boolean => false

/**
 * Create platform-specific store.
 *
 * Uses expo-sqlite on React Native, falls back to memory store on error.
 *
 * @param dbName - Database name (default: 'pnyx')
 */
export const createPlatformStore = (dbName = 'pnyx'): Effect.Effect<Store, never> =>
  ExpoSQLiteStore(`${dbName}.db`).pipe(
    Effect.catchAll((e) => {
      console.warn(`[Store] Failed to create expo-sqlite store, falling back to memory: ${e}`)
      return MemoryStore
    }),
  )

/**
 * Platform store layer for dependency injection.
 *
 * Provides expo-sqlite storage on React Native.
 */
export const PlatformStoreLayer = Layer.effect(StoreService, createPlatformStore())

/**
 * Create platform store layer with custom database name.
 */
export const createPlatformStoreLayer = (dbName: string) => Layer.effect(StoreService, createPlatformStore(dbName))
