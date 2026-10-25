/**
 * MMKV-based storage for React Native.
 *
 * 30x faster than AsyncStorage with no size limits.
 * This is the React Native implementation with static imports.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import {createMMKV} from 'react-native-mmkv'
import {Storage, StorageError} from './types.js'

/**
 * Create MMKV storage for React Native.
 *
 * @param id - Storage instance ID (default: 'pnyx')
 * @param encryptionKey - Optional encryption key for at-rest encryption
 */
export const createMMKVStorage = (id = 'pnyx', encryptionKey?: string): Effect.Effect<Storage, StorageError> =>
  Effect.try({
    try: () => {
      const storage = createMMKV({
        id,
        ...(encryptionKey ? {encryptionKey} : {}),
      })

      const storageImpl: Storage = {
        get: (key: string) =>
          Effect.sync(() => {
            const value = storage.getString(key)
            return value ?? null
          }),

        set: (key: string, value: string) =>
          Effect.sync(() => {
            storage.set(key, value)
          }),

        remove: (key: string) =>
          Effect.sync(() => {
            storage.remove(key)
          }),

        clear: () =>
          Effect.sync(() => {
            storage.clearAll()
          }),

        keys: () =>
          Effect.sync(() => {
            return storage.getAllKeys()
          }),

        multiGet: (keys: readonly string[]) =>
          Effect.sync(() => {
            return keys.map((k) => [k, storage.getString(k) ?? null] as [string, string | null])
          }),

        multiSet: (entries: readonly [string, string][]) =>
          Effect.sync(() => {
            for (const [key, value] of entries) {
              storage.set(key, value)
            }
          }),

        multiRemove: (keys: readonly string[]) =>
          Effect.sync(() => {
            for (const key of keys) {
              storage.remove(key)
            }
          }),
      }

      return storageImpl
    },
    catch: (e) =>
      new StorageError({
        message: `Failed to create MMKV storage: ${e}`,
        cause: e,
      }),
  })

/**
 * MMKV storage layer for dependency injection.
 */
export const MMKVStorageLayer = Layer.effect(Storage, createMMKVStorage())

/**
 * Create MMKV storage layer with custom configuration.
 */
export const createMMKVStorageLayer = (id?: string, encryptionKey?: string) =>
  Layer.effect(Storage, createMMKVStorage(id, encryptionKey))
