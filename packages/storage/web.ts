/**
 * Web browser storage adapter using localStorage.
 *
 * @module
 */

import {Effect, Layer} from 'effect'
import type {Storage} from './types.js'
import {StorageError, Storage as StorageTag} from './types.js'

/**
 * Creates a web storage implementation using localStorage.
 *
 * @returns Web storage service
 */
export const createWebStorage = (): Storage => ({
  get: (key) =>
    Effect.try({
      try: () => localStorage.getItem(key),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  set: (key, value) =>
    Effect.try({
      try: () => {
        localStorage.setItem(key, value)
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  remove: (key) =>
    Effect.try({
      try: () => {
        localStorage.removeItem(key)
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  clear: () =>
    Effect.try({
      try: () => {
        localStorage.clear()
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  keys: () =>
    Effect.try({
      try: () => Object.keys(localStorage),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiGet: (keys) =>
    Effect.try({
      try: () => keys.map((k) => [k, localStorage.getItem(k)] as const),
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiSet: (entries) =>
    Effect.try({
      try: () => {
        for (const [k, v] of entries) {
          localStorage.setItem(k, v)
        }
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),

  multiRemove: (keys) =>
    Effect.try({
      try: () => {
        for (const k of keys) {
          localStorage.removeItem(k)
        }
      },
      catch: (e) => new StorageError({message: String(e), cause: e}),
    }),
})

/**
 * Web storage layer for dependency injection.
 */
export const WebStorageLayer = Layer.sync(StorageTag, createWebStorage)
