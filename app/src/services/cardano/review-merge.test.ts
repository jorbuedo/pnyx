import type {ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {mergeReviewedTx} from './review-merge'

const EMPTY_GROUP = {parties: [], entries: []} as unknown as ReviewedTransaction['ownGroup']

/** The minimum a `ReviewedTransaction` needs; each test overrides what it cares about. */
const base = (over: Partial<ReviewedTransaction>): ReviewedTransaction =>
  ({
    chain: 'cardano',
    fee: 170_000n,
    inputs: [],
    unresolvedInputs: [],
    outputs: [],
    referenceInputs: [],
    metadata: {},
    requiredSigners: [],
    scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 0, redeemers: 0, datums: 0},
    ownDelta: [],
    ownGroup: EMPTY_GROUP,
    identityGroup: EMPTY_GROUP,
    escrowGroup: EMPTY_GROUP,
    otherGroup: EMPTY_GROUP,
    counterparties: [],
    operations: [],
    warnings: [],
    ...over,
  }) as ReviewedTransaction

describe('mergeReviewedTx', () => {
  it('fills the two fields a transaction body cannot carry', () => {
    // `reviewCardanoTx` never sets `hash`, and sets `networkId` only from the
    // optional body field almost nothing populates. Replacing rather than merging
    // is what silently dropped the network row and the transaction id.
    const fromChain = base({cbor: {hex: '84a4', kind: 'transaction'}})
    const fromStore = base({hash: 'aa'.repeat(32), networkId: 1})
    const merged = mergeReviewedTx(fromChain, fromStore)
    expect(merged.hash).toBe('aa'.repeat(32))
    expect(merged.networkId).toBe(1)
    // and it is still the chain-decoded review
    expect(merged.cbor).toEqual({hex: '84a4', kind: 'transaction'})
  })

  it('never lets the stored review overwrite a chain-decoded field', () => {
    const fromChain = base({hash: 'bb'.repeat(32), networkId: 0, status: 'failed', timestamp: '2026-07-26T00:00:00Z'})
    const fromStore = base({
      hash: 'aa'.repeat(32),
      networkId: 1,
      status: 'confirmed',
      timestamp: '2020-01-01T00:00:00Z',
    })
    const merged = mergeReviewedTx(fromChain, fromStore)
    expect(merged.hash).toBe('bb'.repeat(32))
    expect(merged.networkId).toBe(0)
    expect(merged.status).toBe('failed')
    expect(merged.timestamp).toBe('2026-07-26T00:00:00Z')
  })

  it('falls back to a stored date when the chain producer had no indexer answer', () => {
    const merged = mergeReviewedTx(base({}), base({timestamp: '2026-07-19T10:52:00Z', status: 'confirmed'}))
    expect(merged.timestamp).toBe('2026-07-19T10:52:00Z')
    expect(merged.status).toBe('confirmed')
  })

  it('merges block context field by field, chain winning', () => {
    // A row synced before block context was carried holds only a height; the
    // chain answer holds everything. Neither should erase the other.
    const merged = mergeReviewedTx(
      base({block: {slot: 193_521_749, epoch: 645}}),
      base({block: {height: 13_728_487, epoch: 1}}),
    )
    expect(merged.block).toEqual({slot: 193_521_749, epoch: 645, height: 13_728_487})
  })

  it('keeps whichever block exists when only one does', () => {
    expect(mergeReviewedTx(base({block: {height: 7}}), base({})).block).toEqual({height: 7})
    expect(mergeReviewedTx(base({}), base({block: {height: 7}})).block).toEqual({height: 7})
    expect(mergeReviewedTx(base({}), base({})).block).toBeUndefined()
  })

  it('returns the chain review untouched when nothing is stored', () => {
    const fromChain = base({hash: 'cc'.repeat(32)})
    expect(mergeReviewedTx(fromChain, undefined)).toBe(fromChain)
  })
})
