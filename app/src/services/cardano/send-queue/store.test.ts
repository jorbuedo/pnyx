import {createMemoryStorage, type Storage} from '@pnyx/storage'

import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createContinuation} from '../continuation/record'
import {getContinuation, saveContinuation} from '../continuation/store'
import {SEND_QUEUE_CONTEXT, type SendQueueLeg, type SendQueueRequest} from './model'
import {clearQueue, QUEUE_CONTINUATION_ID, resumeQueue, saveQueue} from './store'

const request = (bodyHex: string): SendQueueRequest => ({
  payload: {_tag: 'CardanoTx', bodyHex, networkId: 0},
  groupId: 'g1',
})

const leg = (
  legId: string,
  opts: {readonly consumes?: readonly string[]; readonly changeIds?: readonly string[]} = {},
): SendQueueLeg => ({
  legId,
  txHash: `hash-${legId}`,
  request: request(`body-${legId}`),
  consumedUtxoIds: opts.consumes ?? [`utxo-${legId}:0`],
  changeUtxoIds: opts.changeIds ?? [`hash-${legId}:1`],
  changeOutputs: [{index: 1, valueHex: 'aa'}],
  queuedAt: 1_000,
})

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

/** Write a raw contextData payload, bypassing the typed save path. */
const seedRaw = (storage: Storage, groupId: string, contextData: Record<string, unknown>) =>
  saveContinuation(storage, {
    ...createContinuation({
      groupId,
      continuationId: QUEUE_CONTINUATION_ID,
      context: SEND_QUEUE_CONTEXT,
      expectedStepCount: 1,
    }),
    contextData,
  })

describe('send-queue store', () => {
  it('round-trips a queue through save → resume', async () => {
    const storage = createMemoryStorage()
    const a = leg('a', {consumes: ['confirmed:0']})

    await run(saveQueue(storage, 'g1', [a]))
    const outcome = await run(resumeQueue(storage, 'g1', new Set(['confirmed:0'])))

    expect(outcome).toEqual({_tag: 'Restored', legs: [a]})
  })

  it('reports Empty when nothing was ever queued', async () => {
    const storage = createMemoryStorage()

    expect(await run(resumeQueue(storage, 'g1', new Set()))).toEqual({_tag: 'Empty'})
  })

  it('saving an empty queue removes the record rather than storing a husk', async () => {
    const storage = createMemoryStorage()
    await run(saveQueue(storage, 'g1', [leg('a')]))

    await run(saveQueue(storage, 'g1', []))

    expect(await run(getContinuation(storage, 'g1', QUEUE_CONTINUATION_ID))).toBeNull()
  })

  it('keeps queues of different groups apart', async () => {
    const storage = createMemoryStorage()
    await run(saveQueue(storage, 'g1', [leg('a', {consumes: ['c:0']})]))
    await run(saveQueue(storage, 'g2', [leg('b', {consumes: ['c:1']}), leg('c', {consumes: ['c:2']})]))

    const one = await run(resumeQueue(storage, 'g1', new Set(['c:0'])))
    const two = await run(resumeQueue(storage, 'g2', new Set(['c:1', 'c:2'])))

    expect(one._tag === 'Restored' && one.legs).toHaveLength(1)
    expect(two._tag === 'Restored' && two.legs).toHaveLength(2)
  })

  it('drops legs whose inputs vanished while the app was closed, and persists the pruning', async () => {
    const storage = createMemoryStorage()
    const a = leg('a', {consumes: ['spent-elsewhere:0'], changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['hash-a:1']})
    const independent = leg('c', {consumes: ['still-there:0']})
    await run(saveQueue(storage, 'g1', [a, b, independent]))

    const outcome = await run(resumeQueue(storage, 'g1', new Set(['still-there:0'])))

    expect(outcome._tag).toBe('Invalidated')
    if (outcome._tag === 'Invalidated') {
      expect([...outcome.droppedLegIds].sort()).toEqual(['a', 'b'])
      expect(outcome.legs.map((l) => l.legId)).toEqual(['c'])
    }
    // The pruning is persisted, so a second resume is a clean Restored.
    const again = await run(resumeQueue(storage, 'g1', new Set(['still-there:0'])))
    expect(again._tag).toBe('Restored')
  })

  it('reports Invalidated with an empty queue when every leg went stale', async () => {
    const storage = createMemoryStorage()
    await run(saveQueue(storage, 'g1', [leg('a', {consumes: ['gone:0']})]))

    const outcome = await run(resumeQueue(storage, 'g1', new Set()))

    expect(outcome).toEqual({_tag: 'Invalidated', legs: [], droppedLegIds: ['a']})
    expect(await run(getContinuation(storage, 'g1', QUEUE_CONTINUATION_ID))).toBeNull()
  })

  it('rejects a malformed payload as Corrupt and removes the record', async () => {
    const storage = createMemoryStorage()
    await run(seedRaw(storage, 'g1', {legs: [{legId: 'a', txHash: 'h'}]}))

    expect(await run(resumeQueue(storage, 'g1', new Set()))).toEqual({_tag: 'Corrupt'})
    expect(await run(getContinuation(storage, 'g1', QUEUE_CONTINUATION_ID))).toBeNull()
  })

  it('rejects the whole queue when only one leg is malformed', async () => {
    const storage = createMemoryStorage()
    await run(seedRaw(storage, 'g1', {legs: [leg('good', {consumes: ['c:0']}), {legId: 'bad'}]}))

    // Partial decoding would silently release the good leg's locked inputs.
    expect(await run(resumeQueue(storage, 'g1', new Set(['c:0'])))).toEqual({_tag: 'Corrupt'})
  })

  it('treats a missing legs payload as Corrupt, not as an empty queue', async () => {
    const storage = createMemoryStorage()
    await run(seedRaw(storage, 'g1', {somethingElse: true}))

    expect(await run(resumeQueue(storage, 'g1', new Set()))).toEqual({_tag: 'Corrupt'})
  })

  it('clearQueue removes the record', async () => {
    const storage = createMemoryStorage()
    await run(saveQueue(storage, 'g1', [leg('a')]))

    await run(clearQueue(storage, 'g1'))

    expect(await run(resumeQueue(storage, 'g1', new Set()))).toEqual({_tag: 'Empty'})
  })
})
