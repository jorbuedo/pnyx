/**
 * expo-sqlite token-prices-table stub for non-React Native platforms.
 * Use the IndexedDB or Memory adapter on this platform.
 *
 * @module
 */

import {Effect} from 'effect'
import {StoreError} from './errors.js'
import type {TokenPricesTable} from './token-prices-table.js'

export const ExpoSQLiteTokenPricesTable = (
  _dbName = 'pnyx-token-prices.db',
): Effect.Effect<TokenPricesTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory token-prices-table on this platform.',
    }),
  )
