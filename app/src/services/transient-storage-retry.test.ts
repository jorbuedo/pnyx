import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {TRANSIENT_STORAGE_SYNC_RETRY} from './transient-storage-retry'

/**
 * Exercises the exact schedule the chain sync uses to absorb transient storage
 * blips (IndexedDB connection closing / expo-sqlite handle closed). It pairs
 * `whileInput(isTransientStorageError)` with `recurs(2)`, so it must:
 *  - retry transient failures and succeed once the store recovers,
 *  - fail fast (one attempt) on a non-transient error,
 *  - give up after a bounded number of attempts when the blip never clears
 *    (no infinite loop).
 */
const transient = () => new Error('Failed to list address rows: The database connection is closing.')
const fatal = () => new Error('schema mismatch')

describe('TRANSIENT_STORAGE_SYNC_RETRY', () => {
  it('recovers when a transient storage error clears within the retry budget', async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts += 1
      return attempts <= 2 ? Effect.fail(transient()) : Effect.succeed('ok' as const)
    })

    const result = await Effect.runPromise(Effect.retry(effect, TRANSIENT_STORAGE_SYNC_RETRY))

    expect(result).toBe('ok')
    expect(attempts).toBe(3) // 1 initial + 2 retries
  })

  it('fails immediately (no retry) on a non-transient error', async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts += 1
      return Effect.fail(fatal())
    })

    const exit = await Effect.runPromiseExit(Effect.retry(effect, TRANSIENT_STORAGE_SYNC_RETRY))

    expect(exit._tag).toBe('Failure')
    expect(attempts).toBe(1)
  })

  it('gives up after a bounded number of attempts when the blip never clears', async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts += 1
      return Effect.fail(transient())
    })

    const exit = await Effect.runPromiseExit(Effect.retry(effect, TRANSIENT_STORAGE_SYNC_RETRY))

    expect(exit._tag).toBe('Failure')
    // 1 initial + 2 retries, then it stops — never loops.
    expect(attempts).toBe(3)
  })
})
