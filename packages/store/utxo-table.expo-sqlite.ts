/**
 * expo-sqlite utxo-table stub for non-React Native platforms.
 *
 * This module is only available on React Native. On other platforms, it
 * returns an error indicating expo-sqlite is not available — callers
 * should select the IndexedDB or Memory adapter instead.
 *
 * @module
 */

import {Effect} from 'effect'
import {StoreError} from './errors.js'
import type {UtxoTable} from './utxo-table.js'

export const ExpoSQLiteUtxoTable = (_dbName = 'pnyx-utxo.db'): Effect.Effect<UtxoTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory utxo-table on this platform.',
    }),
  )
