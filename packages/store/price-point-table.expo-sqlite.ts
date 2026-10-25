/**
 * expo-sqlite price-point-table stub for non-React Native platforms.
 * Use the IndexedDB or Memory adapter on this platform.
 *
 * @module
 */

import {Effect} from 'effect'
import {StoreError} from './errors.js'
import type {PricePointTable} from './price-point-table.js'

export const ExpoSQLitePricePointTable = (
  _dbName = 'pnyx-price-point.db',
): Effect.Effect<PricePointTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory price-point-table on this platform.',
    }),
  )
