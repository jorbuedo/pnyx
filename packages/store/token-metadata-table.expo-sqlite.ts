/**
 * expo-sqlite token-metadata-table stub for non-React Native platforms.
 * Use the IndexedDB or Memory adapter on this platform.
 *
 * @module
 */

import {Effect} from 'effect'
import {StoreError} from './errors.js'
import type {TokenMetadataTable} from './token-metadata-table.js'

export const ExpoSQLiteTokenMetadataTable = (
  _dbName = 'pnyx-token-metadata.db',
): Effect.Effect<TokenMetadataTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory token-metadata-table on this platform.',
    }),
  )
