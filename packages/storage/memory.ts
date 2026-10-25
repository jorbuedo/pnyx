/**
 * In-memory storage adapter.
 *
 * Useful for testing or when persistence is not needed.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import type {Storage} from './types.js'
import {Storage as StorageTag} from './types.js'

/**
 * Creates an in-memory storage implementation.
 *
 * @returns In-memory storage service
 */
export const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()

  return {
    get: (key: string) => Effect.sync(() => store.get(key) ?? null),

    set: (key: string, value: string) =>
      Effect.sync(() => {
        store.set(key, value)
      }),

    remove: (key: string) =>
      Effect.sync(() => {
        store.delete(key)
      }),

    clear: () =>
      Effect.sync(() => {
        store.clear()
      }),

    keys: () => Effect.sync(() => Array.from(store.keys())),

    multiGet: (keys: readonly string[]) =>
      Effect.sync(() => keys.map((key): [string, string | null] => [key, store.get(key) ?? null])),

    multiSet: (entries: readonly [string, string][]) =>
      Effect.sync(() => {
        for (const [key, value] of entries) {
          store.set(key, value)
        }
      }),

    multiRemove: (keys: readonly string[]) =>
      Effect.sync(() => {
        for (const key of keys) {
          store.delete(key)
        }
      }),
  }
}

/**
 * In-memory storage layer for dependency injection.
 */
export const MemoryStorageLayer = Layer.sync(StorageTag, createMemoryStorage)
