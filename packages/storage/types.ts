/**
 * Storage types and interfaces.
 *
 * @module
 */

import {Context, Data, type Effect} from 'effect'

/**
 * Error types for storage operations.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class StorageKeyNotFoundError extends Data.TaggedError('StorageKeyNotFoundError')<{
  readonly key: string
}> {}

export class StorageSerializationError extends Data.TaggedError('StorageSerializationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Storage service type for key-value storage operations.
 */
export type Storage = {
  /**
   * Gets a value from storage.
   *
   * @param key - Storage key
   * @returns Effect containing the value or None if not found
   */
  readonly get: (key: string) => Effect.Effect<string | null, StorageError>

  /**
   * Sets a value in storage.
   *
   * @param key - Storage key
   * @param value - Value to store
   * @returns Effect completing when stored
   */
  readonly set: (key: string, value: string) => Effect.Effect<void, StorageError>

  /**
   * Removes a value from storage.
   *
   * @param key - Storage key
   * @returns Effect completing when removed
   */
  readonly remove: (key: string) => Effect.Effect<void, StorageError>

  /**
   * Clears all values from storage.
   *
   * @returns Effect completing when cleared
   */
  readonly clear: () => Effect.Effect<void, StorageError>

  /**
   * Gets all keys in storage.
   *
   * @returns Effect containing array of keys
   */
  readonly keys: () => Effect.Effect<readonly string[], StorageError>

  /**
   * Gets multiple values from storage.
   *
   * @param keys - Array of storage keys
   * @returns Effect containing array of [key, value] pairs
   */
  readonly multiGet: (keys: readonly string[]) => Effect.Effect<readonly [string, string | null][], StorageError>

  /**
   * Sets multiple values in storage.
   *
   * @param entries - Array of [key, value] pairs
   * @returns Effect completing when all values stored
   */
  readonly multiSet: (entries: readonly [string, string][]) => Effect.Effect<void, StorageError>

  /**
   * Removes multiple values from storage.
   *
   * @param keys - Array of storage keys
   * @returns Effect completing when all values removed
   */
  readonly multiRemove: (keys: readonly string[]) => Effect.Effect<void, StorageError>
}

/**
 * Storage service tag for dependency injection.
 */
export const Storage = Context.GenericTag<Storage>('Storage')

/**
 * Platform type for storage detection.
 */
export type Platform = 'react-native' | 'browser' | 'browser-extension' | 'node' | 'unknown'
