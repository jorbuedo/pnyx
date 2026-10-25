/**
 * expo-sqlite store stub for non-React Native platforms.
 *
 * This module is only available on React Native. On other platforms,
 * it returns an error indicating expo-sqlite is not available.
 *
 * @module
 */

import {Effect} from 'effect'
import {StoreError} from './errors.js'
import type {StoreService} from './store.js'

/**
 * Create a SQLite-based store using expo-sqlite (stub - not available on this platform).
 *
 * @param _dbName - Database file name (unused)
 */
export const ExpoSQLiteStore = (_dbName = 'pnyx.db'): Effect.Effect<typeof StoreService.Service, StoreError> =>
  Effect.fail(
    new StoreError({
      message: 'expo-sqlite is only available on React Native. Use a different storage backend on this platform.',
    }),
  )
