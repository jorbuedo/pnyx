/**
 * expo-sqlite resilient handle stub for non-React Native platforms.
 *
 * Real implementation lives in {@link ./expo-sqlite-resilient.native.ts} and
 * is selected by Metro on React Native builds.
 *
 * @module
 */

import type * as SQLite from 'expo-sqlite'

export type ResilientDb = {
  readonly with: <A>(op: (db: SQLite.SQLiteDatabase) => Promise<A>) => Promise<A>
  readonly close: () => Promise<void>
}

export const isStaleNativeHandleError = (_e: unknown): boolean => false

export const openResilientDb = (
  _dbName: string,
  _initSchema: (db: SQLite.SQLiteDatabase) => Promise<void>,
): Promise<ResilientDb> => Promise.reject(new Error('expo-sqlite is only available on React Native'))
