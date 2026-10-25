/**
 * JSON storage utilities.
 *
 * Provides type-safe JSON serialization/deserialization for storage.
 *
 * @module
 */

import {Effect} from 'effect'
import {Storage, type StorageError, StorageSerializationError} from './types.js'

/**
 * Gets a JSON value from storage with type safety.
 *
 * @param key - Storage key
 * @returns Effect containing the parsed value or null if not found
 */
export const getJson = <T>(key: string): Effect.Effect<T | null, StorageSerializationError | StorageError, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const value = yield* storage.get(key)

    if (value === null) {
      return null
    }

    try {
      return JSON.parse(value) as T
    } catch (error) {
      return yield* Effect.fail(
        new StorageSerializationError({
          message: `Failed to parse JSON for key "${key}"`,
          cause: error,
        }),
      )
    }
  })

/**
 * Sets a JSON value in storage.
 *
 * @param key - Storage key
 * @param value - Value to store (will be JSON serialized)
 * @returns Effect completing when stored
 */
export const setJson = <T>(
  key: string,
  value: T,
): Effect.Effect<void, StorageSerializationError | StorageError, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage

    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch (error) {
      return yield* Effect.fail(
        new StorageSerializationError({
          message: `Failed to serialize JSON for key "${key}"`,
          cause: error,
        }),
      )
    }

    yield* storage.set(key, serialized)
  })

/**
 * Gets a JSON value from storage with a default value.
 *
 * @param key - Storage key
 * @param defaultValue - Default value if key not found
 * @returns Effect containing the parsed value or default
 */
export const getJsonWithDefault = <T>(
  key: string,
  defaultValue: T,
): Effect.Effect<T, StorageSerializationError | StorageError, Storage> =>
  Effect.gen(function* () {
    const value = yield* getJson<T>(key)
    return value ?? defaultValue
  })

/**
 * Updates a JSON value in storage.
 *
 * @param key - Storage key
 * @param updater - Function to update the value
 * @param defaultValue - Default value if key not found
 * @returns Effect containing the updated value
 */
export const updateJson = <T>(
  key: string,
  updater: (current: T) => T,
  defaultValue: T,
): Effect.Effect<T, StorageSerializationError | StorageError, Storage> =>
  Effect.gen(function* () {
    const current = yield* getJsonWithDefault(key, defaultValue)
    const updated = updater(current)
    yield* setJson(key, updated)
    return updated
  })
