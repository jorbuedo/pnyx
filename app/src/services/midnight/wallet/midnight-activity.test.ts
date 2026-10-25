import {describe, expect, it} from 'vitest'

import {
  type MidnightActivity,
  mergeActivityByTransaction,
  midnightActivityOf,
  normalizeBlockTimestamp,
} from './midnight-activity'
import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

const OURS = 'mn_addr_preprod1ours'
const THEIRS = 'mn_addr_preprod1theirs'

const utxo = (over: Record<string, unknown> = {}) => ({
  owner: OURS,
  tokenType: NIGHT_TOKEN_TYPE,
  value: '1000000',
  intentHash: 'aa11',
  outputIndex: 0,
  ...over,
})

const tx = (over: Record<string, unknown> = {}) => ({
  id: 7,
  hash: 'deadbeef',
  fee: '1500',
  block: {height: 2_176_000, timestamp: 1_787_170_404_000},
  ...over,
})

describe('normalizeBlockTimestamp', () => {
  it('reads a millisecond value as-is', () => {
    expect(normalizeBlockTimestamp(1_787_170_404_000)).toBe('2026-08-19T20:13:24.000Z')
  })

  it('reads a second value by scaling it', () => {
    // The schema types this Int, which cannot hold milliseconds, so both units are possible.
    expect(normalizeBlockTimestamp(1_787_170_404)).toBe('2026-08-19T20:13:24.000Z')
  })

  it('reports an absent or nonsensical time as absent rather than 1970', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeBlockTimestamp(bad)).toBeUndefined()
    }
  })
})

describe('midnightActivityOf', () => {
  it('counts only our own outputs, because the feed reports only our side', () => {
    // The recipient's output is in the transaction but not in an address-scoped event: verified on a
    // real preprod transfer where the chain showed 2 created outputs and the event carried 1.
    const activity = midnightActivityOf(
      {
        transaction: tx(),
        createdUtxos: [utxo({owner: THEIRS, value: '400000'}), utxo({outputIndex: 1, value: '100000'})],
        spentUtxos: [utxo({value: '600000'})],
      },
      OURS,
    )
    expect(activity?.ourSpentCount).toBe(1)
    expect(activity?.ourCreatedCount).toBe(1)
  })

  it('projects a received transaction', () => {
    const activity = midnightActivityOf({transaction: tx(), createdUtxos: [utxo()], spentUtxos: []}, OURS)
    expect(activity).toMatchObject({
      transactionId: 7,
      hash: 'deadbeef',
      timestamp: '2026-08-19T20:13:24.000Z',
      blockHeight: 2_176_000,
      direction: 'received',
      fee: 1500n,
      counterparties: [],
    })
    expect(activity?.netByToken.get(NIGHT_TOKEN_TYPE)).toBe(1_000_000n)
  })

  it('projects a send as a negative net with the recipient as counterparty', () => {
    const activity = midnightActivityOf(
      {
        transaction: tx(),
        createdUtxos: [utxo({owner: THEIRS, value: '400000'}), utxo({outputIndex: 1, value: '100000'})],
        spentUtxos: [utxo({value: '600000'})],
      },
      OURS,
    )
    expect(activity?.direction).toBe('sent')
    // Spent 600000, kept 100000 as change → net -500000.
    expect(activity?.netByToken.get(NIGHT_TOKEN_TYPE)).toBe(-500_000n)
    expect(activity?.counterparties).toEqual([THEIRS])
  })

  it('calls a transaction that only pays us back a self-transfer, not a receipt', () => {
    // Nets to zero, but something did happen — and "received 0" would be a lie.
    const activity = midnightActivityOf(
      {transaction: tx(), createdUtxos: [utxo()], spentUtxos: [utxo({outputIndex: 3})]},
      OURS,
    )
    // The indexer reports both sides, and so do we now — a self-send spends its inputs and creates
    // its outputs whatever the net came to.
    expect(activity?.ourSpentCount).toBe(1)
    expect(activity?.ourCreatedCount).toBe(1)
    expect(activity?.direction).toBe('self')
    expect([...(activity?.netByToken.entries() ?? [])]).toEqual([])
    // The net cancelled, and the token still moved. Recording that separately is what keeps a
    // self-send in NIGHT's own activity list: a filter over `netByToken` could not see it.
    expect([...(activity?.tokens ?? [])]).toEqual([NIGHT_TOKEN_TYPE])
  })

  it('records only tokens that moved for us, never a counterparty side', () => {
    const activity = midnightActivityOf(
      {
        transaction: tx(),
        createdUtxos: [utxo({owner: THEIRS, tokenType: 'ff'.repeat(32), value: '5'})],
        spentUtxos: [utxo({value: '600000'})],
      },
      OURS,
    )
    expect([...(activity?.tokens ?? [])]).toEqual([NIGHT_TOKEN_TYPE])
  })

  it('ignores outputs and spends that are not ours when netting', () => {
    const activity = midnightActivityOf(
      {transaction: tx(), createdUtxos: [utxo({owner: THEIRS, value: '999'})], spentUtxos: [utxo({owner: THEIRS})]},
      OURS,
    )
    expect(activity).toBeNull()
  })

  it('drops an event with no transaction id or hash rather than inventing one', () => {
    expect(midnightActivityOf({transaction: tx({id: undefined}), createdUtxos: [utxo()]}, OURS)).toBeNull()
    expect(midnightActivityOf({transaction: tx({hash: undefined}), createdUtxos: [utxo()]}, OURS)).toBeNull()
    expect(midnightActivityOf({transaction: null, createdUtxos: [utxo()]}, OURS)).toBeNull()
  })

  it('omits an unstated fee instead of reporting zero', () => {
    const activity = midnightActivityOf({transaction: tx({fee: null}), createdUtxos: [utxo()]}, OURS)
    expect(activity?.fee).toBeUndefined()
  })

  it('omits an unparseable fee', () => {
    const activity = midnightActivityOf({transaction: tx({fee: '1.5e3'}), createdUtxos: [utxo()]}, OURS)
    expect(activity?.fee).toBeUndefined()
  })

  it('leaves a transaction with no block time undated rather than dating it now', () => {
    const activity = midnightActivityOf({transaction: tx({block: null}), createdUtxos: [utxo()]}, OURS)
    expect(activity?.timestamp).toBeUndefined()
    expect(activity?.blockHeight).toBeUndefined()
  })

  it('deduplicates counterparties', () => {
    const activity = midnightActivityOf(
      {
        transaction: tx(),
        createdUtxos: [utxo({owner: THEIRS}), utxo({owner: THEIRS, outputIndex: 1})],
        spentUtxos: [utxo({value: '2000000'})],
      },
      OURS,
    )
    expect(activity?.counterparties).toEqual([THEIRS])
  })
})

describe('mergeActivityByTransaction', () => {
  const NIGHT = '00'.repeat(32)
  const OTHER = '07'.repeat(32)

  const row = (over: Partial<MidnightActivity> = {}): MidnightActivity => ({
    transactionId: 10,
    hash: 'aa'.repeat(32),
    direction: 'received',
    netByToken: new Map([[NIGHT, 1_000n]]),
    tokens: new Set([NIGHT]),
    identifiers: ['id-1'],
    ourSpentCount: 0,
    ourCreatedCount: 1,
    counterparties: [],
    ...over,
  })

  it('leaves a single row alone', () => {
    const only = row()
    expect(mergeActivityByTransaction([only])).toEqual([only])
  })

  it('collapses two parts of one transaction into one row', () => {
    // The defect this exists for: a faucet payout on preprod arrived as two events and the activity
    // list showed the transfer twice, with React also complaining about the duplicate key.
    const merged = mergeActivityByTransaction([row({identifiers: ['id-1']}), row({identifiers: ['id-2']})])
    expect(merged).toHaveLength(1)
  })

  it('sums the amounts rather than keeping the first', () => {
    // Each event carries only its own part, so "keep the first" would under-report what moved.
    const merged = mergeActivityByTransaction([
      row({netByToken: new Map([[NIGHT, 600n]])}),
      row({netByToken: new Map([[NIGHT, 400n]])}),
    ])
    expect(merged[0]?.netByToken.get(NIGHT)).toBe(1_000n)
  })

  it('drops a token that nets to zero across the parts', () => {
    // Same rule a single event follows: absent, not zero — which is what makes a merged self-send
    // look like one instead of like a 0 NIGHT transfer.
    const merged = mergeActivityByTransaction([
      row({netByToken: new Map([[NIGHT, 500n]]), ourCreatedCount: 1}),
      row({netByToken: new Map([[NIGHT, -500n]]), ourSpentCount: 1, ourCreatedCount: 0}),
    ])
    expect(merged[0]?.netByToken.has(NIGHT)).toBe(false)
  })

  it('re-derives the direction from the merged net, not from either half', () => {
    // Individually one part looks received and the other sent; together they are a self-send.
    const merged = mergeActivityByTransaction([
      row({netByToken: new Map([[NIGHT, 500n]]), direction: 'received', ourCreatedCount: 1}),
      row({netByToken: new Map([[NIGHT, -500n]]), direction: 'sent', ourSpentCount: 1, ourCreatedCount: 0}),
    ])
    expect(merged[0]?.direction).toBe('self')
  })

  it('keeps the tokens each part touched, even when the net cancels', () => {
    const merged = mergeActivityByTransaction([
      row({netByToken: new Map([[NIGHT, 5n]]), tokens: new Set([NIGHT])}),
      row({netByToken: new Map([[OTHER, 5n]]), tokens: new Set([OTHER])}),
    ])
    expect(merged[0]?.tokens).toEqual(new Set([NIGHT, OTHER]))
  })

  it('unions identifiers, because they are per-intent', () => {
    // The two rows of one transaction legitimately carry different identifiers — which is exactly why
    // the merge keys on the hash and not on them.
    const merged = mergeActivityByTransaction([row({identifiers: ['a']}), row({identifiers: ['b']})])
    expect([...(merged[0]?.identifiers ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('sums our own spent and created counts', () => {
    const merged = mergeActivityByTransaction([
      row({ourSpentCount: 1, ourCreatedCount: 1}),
      row({ourSpentCount: 2, ourCreatedCount: 3}),
    ])
    expect(merged[0]?.ourSpentCount).toBe(3)
    expect(merged[0]?.ourCreatedCount).toBe(4)
  })

  it('takes the fee once rather than adding it', () => {
    // The fee belongs to the transaction. Adding it per part would double it.
    const merged = mergeActivityByTransaction([row({fee: 700n}), row({fee: 700n})])
    expect(merged[0]?.fee).toBe(700n)
  })

  it('keeps the earliest transaction id, so a later part cannot move it in the list', () => {
    const merged = mergeActivityByTransaction([row({transactionId: 30}), row({transactionId: 12})])
    expect(merged[0]?.transactionId).toBe(12)
  })

  it('fills a missing timestamp or block from whichever part has it', () => {
    const merged = mergeActivityByTransaction([row({}), row({timestamp: '2026-08-22T00:00:00Z', blockHeight: 9})])
    expect(merged[0]?.timestamp).toBe('2026-08-22T00:00:00Z')
    expect(merged[0]?.blockHeight).toBe(9)
  })

  it('keeps different transactions apart', () => {
    const merged = mergeActivityByTransaction([row({hash: 'aa'.repeat(32)}), row({hash: 'bb'.repeat(32)})])
    expect(merged).toHaveLength(2)
  })

  it('never folds a pending row into an indexed one', () => {
    // A pending row is a local synthesis with no block behind it; merging would make an unconfirmed
    // send look confirmed.
    const merged = mergeActivityByTransaction([row({pending: true}), row({})])
    expect(merged).toHaveLength(2)
    expect(merged.filter((r) => r.pending === true)).toHaveLength(1)
  })

  it('produces unique hashes, which is what the list keys on', () => {
    const merged = mergeActivityByTransaction([row(), row(), row({hash: 'cc'.repeat(32)})])
    const hashes = merged.filter((r) => r.pending !== true).map((r) => r.hash)
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})

describe('a self-send is one row, not two', () => {
  // ⚠️ The regression this function existed for and was never called against. The fold emits a row
  // per *event*: a self-send spends our inputs and pays our outputs, so it produces two rows carrying
  // the same hash. Rendered unmerged they are visibly duplicated and React warns about the key.
  const NIGHT = '00'.repeat(32)
  const selfRow = (over: Partial<MidnightActivity> = {}): MidnightActivity => ({
    transactionId: 10,
    hash: 'aa'.repeat(32),
    direction: 'received',
    netByToken: new Map([[NIGHT, 1_000n]]),
    tokens: new Set([NIGHT]),
    identifiers: ['id-1'],
    ourSpentCount: 0,
    ourCreatedCount: 1,
    counterparties: [],
    ...over,
  })

  it('merges the two events of one transaction into a single row', () => {
    const hash = 'c8f318f22cb2b5909513361538ab3120f4108e99e83371e1fc6c91d5bd67420a'
    const spend = selfRow({identifiers: ['id-spend'], hash, transactionId: 7})
    const receive = selfRow({identifiers: ['id-receive'], hash, transactionId: 8})
    const merged = mergeActivityByTransaction([spend, receive])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.hash).toBe(hash)
  })

  it('keeps distinct transactions apart', () => {
    const merged = mergeActivityByTransaction([
      selfRow({identifiers: ['a'], hash: 'aa'.repeat(32), transactionId: 1}),
      selfRow({identifiers: ['b'], hash: 'bb'.repeat(32), transactionId: 2}),
    ])
    expect(merged).toHaveLength(2)
  })
})
