/**
 * expo-sqlite address-table stub for non-React Native platforms.
 *
 * This module is only available on React Native. On other platforms, it
 * returns an error indicating expo-sqlite is not available — callers
 * should select the IndexedDB or Memory adapter instead.
 *
 * @module
 */

import {Effect} from 'effect'
import type {AddressTable} from './address-table.js'
import {StoreError} from './errors.js'

export const ExpoSQLiteAddressTable = (_dbName = 'pnyx-address.db'): Effect.Effect<AddressTable, StoreError> =>
  Effect.fail(
    new StoreError({
      message:
        'expo-sqlite is only available on React Native. Use the IndexedDB or Memory address-table on this platform.',
    }),
  )
