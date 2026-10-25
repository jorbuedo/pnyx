/**
 * Browser extension storage adapter.
 *
 * Uses the WebExtension browser.storage.local API for persistent storage.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import type {Storage} from './types.js'
import {StorageError, Storage as StorageTag} from './types.js'

/**
 * Browser storage API interface (subset of WebExtension browser.storage.local).
 */
export type BrowserStorageApi = {
  get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
  clear: () => Promise<void>
}

/**
 * Creates a browser extension storage implementation.
 *
 * @param storageApi - The browser.storage.local API (from WXT or WebExtension)
 * @returns Browser extension storage service
 */
export const createBrowserExtensionStorage = (storageApi: BrowserStorageApi): Storage => ({
  get: (key) =>
    Effect.tryPromise({
      try: async () => {
        const result = await storageApi.get(key)
        return (result[key] as string) ?? null
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  set: (key, value) =>
    Effect.tryPromise({
      try: () => storageApi.set({[key]: value}),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  remove: (key) =>
    Effect.tryPromise({
      try: () => storageApi.remove(key),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  clear: () =>
    Effect.tryPromise({
      try: () => storageApi.clear(),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  keys: () =>
    Effect.tryPromise({
      try: async () => Object.keys(await storageApi.get(null)),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiGet: (keys) =>
    Effect.tryPromise({
      try: async () => {
        const result = await storageApi.get([...keys])
        return keys.map((k) => [k, (result[k] as string) ?? null] as const)
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiSet: (entries) =>
    Effect.tryPromise({
      try: () => storageApi.set(Object.fromEntries(entries)),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiRemove: (keys) =>
    Effect.tryPromise({
      try: () => storageApi.remove([...keys]),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),
})

/**
 * Creates a browser extension storage layer for dependency injection.
 *
 * @param storageApi - The browser.storage.local API (from WXT or WebExtension)
 * @returns Storage layer
 */
export const createBrowserExtensionStorageLayer = (storageApi: BrowserStorageApi) =>
  Layer.sync(StorageTag, () => createBrowserExtensionStorage(storageApi))
