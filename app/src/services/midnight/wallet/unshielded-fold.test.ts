import {describe, expect, it} from 'vitest'

import {
  emptyFold,
  foldDrainedOnHeartbeat,
  foldedActivity,
  foldIsCaughtUp,
  foldShouldStop,
  foldUnshieldedFrame,
  type UnshieldedFrame,
} from './unshielded-fold'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ADDRESS = 'mn_addr_preprod1ours'
const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000'

const utxo = (over: Record<string, unknown> = {}) => ({
  owner: ADDRESS,
  tokenType: NIGHT,
  value: '1000000',
  intentHash: 'aa11',
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

const progress = (highestTransactionId: number): UnshieldedFrame =>
  ({__typename: 'UnshieldedTransactionsProgress', highestTransactionId}) as unknown as UnshieldedFrame

const tx = (id: number, created: readonly unknown[] = [], spent: readonly unknown[] = []): UnshieldedFrame =>
  ({
    __typename: 'UnshieldedTransaction',
    transaction: {id, hash: `hash${id}`},
    createdUtxos: created,
    spentUtxos: spent,
  }) as unknown as UnshieldedFrame

const fold = (frames: readonly UnshieldedFrame[], from?: Parameters<typeof emptyFold>[0]) =>
  frames.reduce((state, frame) => foldUnshieldedFrame(state, frame, ADDRESS), emptyFold(from))

describe('foldUnshieldedFrame', () => {
  it('a progress frame moves the highest id and applies nothing', () => {
    // The regression this guards: progress arrives *first*, so counting it as work — or as completion —
    // reads every funded address as empty.
    const state = fold([progress(7)])
    expect(state.highestTransactionId).toBe(7)
    expect(state.applied).toBe(0)
    expect(state.utxos.size).toBe(0)
  })

  it('adds a created output and advances the cursor', () => {
    const state = fold([tx(3, [utxo()])])
    expect(state.utxos.size).toBe(1)
    expect(state.lastSeenId).toBe(3)
    expect(state.applied).toBe(1)
  })

  it('drops an output a later frame spends', () => {
    const state = fold([tx(1, [utxo()]), tx(2, [], [utxo()])])
    expect(state.utxos.size).toBe(0)
  })

  it('resumes from a cursor without losing the seeded set', () => {
    const seeded = new Map<string, UnshieldedUtxo>([
      ['aa11:0', {...utxo(), value: 1_000_000n, ctime: null} as unknown as UnshieldedUtxo],
    ])
    const state = fold([tx(9, [utxo({intentHash: 'bb22'})])], {utxos: seeded, transactionId: 8})
    expect(state.utxos.size).toBe(2)
    expect(state.lastSeenId).toBe(9)
  })
})

describe('foldIsCaughtUp', () => {
  it('an address with no history is read, not pending', () => {
    expect(foldIsCaughtUp(emptyFold())).toBe(true)
  })

  it('is false once frames have arrived but the indexer has named no highest id', () => {
    // Saying "caught up" here would strand a caller mid-history with a set it believes is complete.
    expect(foldIsCaughtUp(fold([tx(1, [utxo()])]))).toBe(false)
  })

  it('is true once the replay reaches the named id', () => {
    expect(foldIsCaughtUp(fold([progress(2), tx(1, [utxo()])]))).toBe(false)
    expect(foldIsCaughtUp(fold([progress(2), tx(1, [utxo()]), tx(2, [utxo({outputIndex: 1})])]))).toBe(true)
  })
})

describe('foldShouldStop', () => {
  it('stops on a highest id of zero — nothing to replay is a complete answer', () => {
    expect(foldShouldStop(fold([progress(0)]))).toBe(true)
  })

  it('does not stop on the leading progress frame when there is history to replay', () => {
    expect(foldShouldStop(fold([progress(5)]))).toBe(false)
  })
})

describe('foldedActivity', () => {
  it('merges the parts of one transaction into a single row', () => {
    // The feed yields one event per relevant *part*, so a sponsored transaction — a faucet payout —
    // arrives twice and would otherwise be listed twice.
    const state = fold([tx(4, [utxo()]), tx(4, [utxo({outputIndex: 1})])])
    expect(state.activity.length).toBe(2)
    expect(foldedActivity(state).length).toBe(1)
  })

  it('is not folded into the state, because merging is not idempotent', () => {
    // A live feed merges on read, never per frame: merging an already-merged row into itself is how a
    // long-running subscription would start double-counting what it holds.
    const state = fold([tx(4, [utxo()]), tx(4, [utxo({outputIndex: 1})])])
    const once = foldedActivity(state)
    const twice = foldedActivity({...state, activity: once})
    expect(twice.length).toBe(once.length)
  })
})

describe('catching up when the announced id is never reached', () => {
  // ⚠️ `highestTransactionId` is the id the *indexer* named. It is per-address today, but nothing
  // guarantees this address reaches it — and if it does not, the primary rule is false for ever: no
  // cache write, no `settlePendingSends`, and every send waits out `awaitFeedCaughtUp` and is refused.

  it('a repeated heartbeat drains a replay the primary rule could never finish', () => {
    // The indexer names 9, sends transaction 1, then says 9 twice more with nothing in between.
    const state = fold([progress(9), tx(1, [utxo()]), progress(9), progress(9)])
    expect(state.lastSeenId).toBe(1)
    expect(state.highestTransactionId).toBe(9)
    expect(foldDrainedOnHeartbeat(state)).toBe(true)
    expect(foldIsCaughtUp(state)).toBe(true)
  })

  it('one repeat is not enough, because a single stalled heartbeat mid-replay looks the same', () => {
    // The unsafe direction: declaring catch-up here would let a send select from a partial set.
    const state = fold([progress(9), tx(1, [utxo()]), progress(9)])
    expect(foldDrainedOnHeartbeat(state)).toBe(false)
    expect(foldIsCaughtUp(state)).toBe(false)
  })

  it('a transaction between heartbeats restarts the count', () => {
    // A replay that is still delivering, slowly. Two repeats separated by real news must not add up.
    const state = fold([progress(9), progress(9), tx(1, [utxo()]), progress(9)])
    expect(state.progressRepeats).toBe(1)
    expect(foldIsCaughtUp(state)).toBe(false)
  })

  it('a moving target restarts the count rather than accumulating', () => {
    const state = fold([progress(9), progress(9), progress(11), progress(11)])
    expect(state.highestTransactionId).toBe(11)
    // Two repeats of 9, then 11 resets, then one repeat of 11.
    expect(state.progressRepeats).toBe(1)
  })

  it('says nothing about an address that has genuinely caught up the primary way', () => {
    const state = fold([progress(2), tx(1, [utxo()]), tx(2, [utxo({outputIndex: 1})]), progress(2), progress(2)])
    expect(foldIsCaughtUp(state)).toBe(true)
    // Caught up by the primary rule, so the fallback must not claim this as its own.
    expect(foldDrainedOnHeartbeat(state)).toBe(false)
  })
})
