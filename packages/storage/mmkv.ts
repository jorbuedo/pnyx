/**
 * MMKV storage stub for non-React Native platforms.
 *
 * This module is only available on React Native. On other platforms,
 * it returns an error indicating MMKV is not available.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import type {Storage} from './types.js'
import {StorageError, Storage as StorageTag} from './types.js'

/**
 * Create MMKV storage (stub - not available on this platform).
 *
 * @param _id - Storage instance ID (unused)
 * @param _encryptionKey - Optional encryption key (unused)
 */
export const createMMKVStorage = (_id = 'pnyx', _encryptionKey?: string): Effect.Effect<Storage, StorageError> =>
  Effect.fail(
    new StorageError({
      message: 'MMKV is only available on React Native. Use a different storage backend on this platform.',
    }),
  )

/**
 * MMKV storage layer (stub - fails on non-RN platforms).
 */
export const MMKVStorageLayer: Layer.Layer<Storage, StorageError> = Layer.effect(StorageTag, createMMKVStorage())

/**
 * Create MMKV storage layer (stub - fails on non-RN platforms).
 */
export const createMMKVStorageLayer = (_id?: string, _encryptionKey?: string): Layer.Layer<Storage, StorageError> =>
  Layer.effect(StorageTag, createMMKVStorage(_id, _encryptionKey))
