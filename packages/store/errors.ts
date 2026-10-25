import {Data} from 'effect'

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KeyNotFoundError extends Data.TaggedError('KeyNotFoundError')<{
  readonly message: string
  readonly key: Uint8Array
}> {}

export class StoreClosedError extends Data.TaggedError('StoreClosedError')<{
  readonly message: string
}> {}

export class TransactionError extends Data.TaggedError('TransactionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type StoreErrors = StoreError | KeyNotFoundError | StoreClosedError | TransactionError

/**
 * True when a store error reflects a transient backend lifecycle/contention
 * condition that a bounded retry can recover from, rather than a real bug.
 *
 * Covers both platform backends, matched on the wrapped `StoreError.message`:
 * - IndexedDB (extension): the database connection / transaction is torn down
 *   mid-op when the popup or MV3 service worker is suspended.
 * - expo-sqlite (mobile): the handle is closed by an Android activity/DB
 *   teardown, or SQLite reports BUSY/locked under write contention.
 *
 * Deliberately conservative — does NOT match a bare `InvalidStateError`, which
 * can also signal a genuine API-misuse bug; only the specific closing/locked
 * phrases are treated as retryable. The native stale-handle
 * `NullPointerException` class is already reopened+retried inside
 * `expo-sqlite-resilient.native.ts`, so it never reaches this check.
 */
export const isTransientStorageError = (message: string): boolean => {
  const m = message.toLowerCase()
  return (
    m.includes('database connection is closing') ||
    m.includes("'transaction' on 'idbdatabase'") ||
    m.includes('database is closed') ||
    m.includes('database is closing') ||
    m.includes('database is locked') ||
    m.includes('database is busy')
  )
}
