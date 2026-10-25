/**
 * expo-sqlite assets-table stub for non-React Native platforms.
 *
 * This module is only available on React Native. On other platforms, it
 * returns an error indicating expo-sqlite is not available — callers should
 * select the IndexedDB or Memory adapter instead.
 *
 * @module
 */

import {Effect} from 'effect'
import type {AssetsTable} from './assets-table.js'
import {StoreError} from './errors.js'

export const ExpoSQLiteAssetsTable = (_dbName = 'pnyx-assets.db'): Effect.Effect<AssetsTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory assets-table on this platform.',
    }),
  )
