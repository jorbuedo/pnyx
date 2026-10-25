import {describe, expect, it} from 'vitest'
import {isTransientStorageError} from './errors.js'

describe('isTransientStorageError', () => {
  it('matches the IndexedDB connection-closing error (extension)', () => {
    // The exact message shape seen in production (a production Sentry event), wrapped
    // through StoreError → "Failed to read prior addresses: ...".
    const msg =
      "Failed to read prior addresses: StoreError: Failed to list address rows: InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."
    expect(isTransientStorageError(msg)).toBe(true)
  })

  it('matches the expo-sqlite closed-handle error (mobile)', () => {
    expect(isTransientStorageError('StoreError: Failed to list address rows: Database is closed')).toBe(true)
  })

  it('matches SQLite BUSY/locked contention (mobile)', () => {
    expect(isTransientStorageError('Error: database is locked')).toBe(true)
    expect(isTransientStorageError('Error: database is busy')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isTransientStorageError('THE DATABASE CONNECTION IS CLOSING')).toBe(true)
  })

  it('does NOT match non-transient store failures', () => {
    expect(isTransientStorageError('Failed to read prior addresses: schema mismatch')).toBe(false)
    expect(isTransientStorageError('StoreError: key not found')).toBe(false)
    expect(isTransientStorageError('Network request failed')).toBe(false)
  })

  it('does NOT match a bare InvalidStateError (could be a genuine API-misuse bug)', () => {
    expect(isTransientStorageError('InvalidStateError: something unexpected')).toBe(false)
  })
})
