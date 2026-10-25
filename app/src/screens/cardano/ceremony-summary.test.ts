import type {ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {summarizeCeremony} from './ceremony-summary'

const EMPTY_GROUP = {parties: [], entries: [], deltas: []} as unknown as ReviewedTransaction['ownGroup']

const leg = (over: Partial<ReviewedTransaction>): ReviewedTransaction =>
  ({
    chain: 'cardano',
    fee: 0n,
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

const party = (hex: string, bech32: string, received: {assetId?: string; quantity: bigint}[]) =>
  ({
    ownership: {level: 'none'},
    addresses: [{hex, bech32}],
    sent: [],
    received,
  }) as unknown as ReviewedTransaction['otherGroup']['parties'][number]

describe('summarizeCeremony', () => {
  it('counts the legs the confirm authorises', () => {
    expect(summarizeCeremony([leg({}), leg({}), leg({})]).legCount).toBe(3)
  })

  it('sums fees, which ownDelta deliberately excludes', () => {
    const s = summarizeCeremony([leg({fee: 170_000n}), leg({fee: 200_000n})])
    expect(s.totalFee).toBe(370_000n)
  })

  it('nets own movement across legs and splits it for display', () => {
    const s = summarizeCeremony([
      leg({ownDelta: [{quantity: -5_000_000n}]}),
      leg({ownDelta: [{quantity: -3_000_000n}]}),
    ])
    expect(s.sent).toEqual([{quantity: 8_000_000n}])
    expect(s.received).toEqual([])
  })

  it('cancels intermediate change on a chain — the reason the sum is trustworthy', () => {
    // Leg A spends 10 and returns 7 as change; leg B spends that 7 and sends 6.
    // A's change is an own output in A and an own input in B, so summing the
    // deltas leaves the true net (-4) rather than double-counting the 7.
    const s = summarizeCeremony([
      leg({ownDelta: [{quantity: -3_000_000n}]}),
      leg({ownDelta: [{quantity: -1_000_000n}]}),
    ])
    expect(s.sent).toEqual([{quantity: 4_000_000n}])
  })

  it('nets a token received in one leg against the same token sent in another', () => {
    const s = summarizeCeremony([
      leg({ownDelta: [{assetId: 'pol.tok', quantity: 10n}]}),
      leg({ownDelta: [{assetId: 'pol.tok', quantity: -4n}]}),
    ])
    expect(s.received).toEqual([{assetId: 'pol.tok', quantity: 6n}])
    expect(s.sent).toEqual([])
  })

  it('concatenates operations rather than merging them', () => {
    // A registration and a delegation are two things that happen, not one.
    const s = summarizeCeremony([
      leg({operations: [{kind: 'stake-registration'} as never]}),
      leg({operations: [{kind: 'stake-delegation'} as never]}),
    ])
    expect(s.operations.map((o) => o.kind)).toEqual(['stake-registration', 'stake-delegation'])
  })

  it('sums deposits across legs', () => {
    const s = summarizeCeremony([
      leg({operations: [{kind: 'stake-registration', deposit: 2_000_000n} as never]}),
      leg({operations: [{kind: 'stake-registration', deposit: 2_000_000n} as never]}),
    ])
    expect(s.totalDeposit).toBe(4_000_000n)
  })

  it('merges a counterparty paid by two legs into one row', () => {
    const s = summarizeCeremony([
      leg({otherGroup: {parties: [party('aa', 'addr1aa', [{quantity: 1_000_000n}])]} as never}),
      leg({otherGroup: {parties: [party('aa', 'addr1aa', [{quantity: 2_000_000n}])]} as never}),
    ])
    expect(s.counterparties).toHaveLength(1)
    expect(s.counterparties[0]?.bech32).toBe('addr1aa')
    expect(s.counterparties[0]?.received).toEqual([{quantity: 3_000_000n}])
  })

  it('keeps distinct counterparties separate, in first-appearance order', () => {
    const s = summarizeCeremony([
      leg({otherGroup: {parties: [party('bb', 'addr1bb', [{quantity: 1n}])]} as never}),
      leg({otherGroup: {parties: [party('aa', 'addr1aa', [{quantity: 2n}])]} as never}),
    ])
    expect(s.counterparties.map((c) => c.addressKey)).toEqual(['bb', 'aa'])
  })

  it('unions warnings and dedupes them', () => {
    // Any leg's warning must reach the step that holds the confirm.
    const s = summarizeCeremony([
      leg({warnings: ['large-fee', 'no-ttl']}),
      leg({warnings: ['no-ttl', 'spends-unconfirmed-input']}),
    ])
    expect([...s.warnings].sort()).toEqual(['large-fee', 'no-ttl', 'spends-unconfirmed-input'])
  })

  it('summarises a single leg without inventing anything', () => {
    const s = summarizeCeremony([leg({fee: 170_000n, ownDelta: [{quantity: -1_000_000n}]})])
    expect(s).toMatchObject({legCount: 1, totalFee: 170_000n, totalDeposit: 0n, operations: [], warnings: []})
    expect(s.sent).toEqual([{quantity: 1_000_000n}])
  })

  it('handles an empty ceremony without throwing', () => {
    const s = summarizeCeremony([])
    expect(s).toMatchObject({legCount: 0, totalFee: 0n, totalDeposit: 0n})
    expect(s.sent).toEqual([])
    expect(s.counterparties).toEqual([])
  })
})
