import {createMemoryStorage} from '@pnyx/storage'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createContinuation} from './record'
import {appendSignedStep, getContinuation, listContinuations, removeContinuation, saveContinuation} from './store'

const rec = (groupId: string, continuationId: string, expected = 2) =>
  createContinuation({groupId, continuationId, context: 'cardano.signAll', expectedStepCount: expected})

describe('continuation store', () => {
  it('round-trips a record through save → get', async () => {
    const storage = createMemoryStorage()
    const record = rec('g1', 'c1')
    await Effect.runPromise(saveContinuation(storage, record))
    expect(await Effect.runPromise(getContinuation(storage, 'g1', 'c1'))).toEqual(record)
  })

  it('returns null for an absent record', async () => {
    const storage = createMemoryStorage()
    expect(await Effect.runPromise(getContinuation(storage, 'g1', 'missing'))).toBeNull()
  })

  it('lists by group and across groups', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContinuation(storage, rec('g1', 'c1')))
    await Effect.runPromise(saveContinuation(storage, rec('g1', 'c2')))
    await Effect.runPromise(saveContinuation(storage, rec('g2', 'c3')))
    expect(await Effect.runPromise(listContinuations(storage, 'g1'))).toHaveLength(2)
    expect(await Effect.runPromise(listContinuations(storage))).toHaveLength(3)
  })

  it('appendSignedStep persists an advanced record via the reducer', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContinuation(storage, rec('g1', 'c1')))
    const next = await Effect.runPromise(appendSignedStep(storage, 'g1', 'c1', {stepId: '0', txHash: 'aa'}))
    expect(next?.signedSteps).toHaveLength(1)
    expect(next?.status).toBe('signed')
    const reloaded = await Effect.runPromise(getContinuation(storage, 'g1', 'c1'))
    expect(reloaded?.currentStepIndex).toBe(1)
  })

  it('appendSignedStep on a missing record returns null', async () => {
    const storage = createMemoryStorage()
    expect(await Effect.runPromise(appendSignedStep(storage, 'g1', 'gone', {stepId: '0', txHash: 'a'}))).toBeNull()
  })

  it('removeContinuation deletes it', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContinuation(storage, rec('g1', 'c1')))
    await Effect.runPromise(removeContinuation(storage, 'g1', 'c1'))
    expect(await Effect.runPromise(getContinuation(storage, 'g1', 'c1'))).toBeNull()
  })

  it('scopes its keys under the review.continuation prefix', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContinuation(storage, rec('g1', 'c1')))
    const keys = await Effect.runPromise(storage.keys())
    expect(keys).toContain('review.continuation.g1.c1')
  })
})
