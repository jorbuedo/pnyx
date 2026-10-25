/**
 * Platform storage for React Native.
 *
 * Uses MMKV for all storage operations.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import {createMMKVStorage} from './mmkv.native.js'
import type {Platform, Storage} from './types.js'
import {Storage as StorageTag} from './types.js'

/**
 * Detects the current platform.
 *
 * @returns Always 'react-native' in this module
 */
export const detectPlatform = (): Platform => 'react-native'

/**
 * Checks if running in React Native environment.
 */
export const isReactNative = (): boolean => true

/**
 * Checks if running in browser environment.
 */
export const isBrowser = (): boolean => false

/**
 * Checks if running in browser extension environment.
 */
export const isBrowserExtension = (): boolean => false

/**
 * Checks if running in Node.js environment.
 */
export const isNode = (): boolean => false

/**
 * Create platform-specific storage (sync version).
 *
 * Uses MMKV which has a synchronous API.
 */
export const createPlatformStorage = (): Storage => Effect.runSync(createMMKVStorage())

/**
 * Create platform-specific storage using MMKV (Effect version).
 */
export const createPlatformStorageEffect = (): Effect.Effect<Storage, never> =>
  createMMKVStorage().pipe(
    Effect.catchAll((e) => {
      return Effect.die(new Error(`MMKV is required on React Native but failed to initialize: ${e}`))
    }),
  )

/**
 * Platform-aware storage layer (sync version).
 *
 * Uses MMKV which is synchronous on React Native.
 */
export const PlatformStorageLayer: Layer.Layer<Storage> = Layer.sync(StorageTag, createPlatformStorage)

/**
 * Platform-aware storage layer using MMKV (Effect version).
 */
export const PlatformStorageLayerEffect: Layer.Layer<Storage> = Layer.effect(StorageTag, createPlatformStorageEffect())
