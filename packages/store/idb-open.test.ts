import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {StoreError} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'

const backingStoreError = () => new StoreError({message: 'Internal error opening backing store for indexedDB.open.'})

describe('withIndexedDbOpenRetry', () => {
  it('retries a transient backing-store failure and eventually succeeds', async () => {
    let attempts = 0
    const open = Effect.suspend(() => {
      attempts++
      return attempts < 3 ? Effect.fail(backingStoreError()) : Effect.succeed('db' as const)
    })

    const result = await Effect.runPromise(withIndexedDbOpenRetry(open))

    expect(result).toBe('db')
    expect(attempts).toBe(3)
  })

  it('surfaces the StoreError after exhausting retries (1 initial + 6 retries)', async () => {
    let attempts = 0
    const open = Effect.suspend(() => {
      attempts++
      return Effect.fail(backingStoreError())
    })

    const exit = await Effect.runPromiseExit(withIndexedDbOpenRetry(open))

    expect(exit._tag).toBe('Failure')
    expect(attempts).toBe(7)
  })

  it('does not retry when the open succeeds on the first attempt', async () => {
    let attempts = 0
    const open = Effect.suspend(() => {
      attempts++
      return Effect.succeed('db' as const)
    })

    await Effect.runPromise(withIndexedDbOpenRetry(open))

    expect(attempts).toBe(1)
  })
})
