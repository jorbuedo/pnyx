import {describe, expect, it} from 'vitest'
import {historyEntriesOf, txStatusOf, type WalletTransaction} from './tx-status.js'

const tx = (over: Partial<WalletTransaction> = {}): WalletTransaction => ({
  hash: 'aa11',
  pending: false,
  abandoned: false,
  ...over,
})

describe('txStatusOf', () => {
  it('reports a send in flight as pending', () => {
    expect(txStatusOf(tx({hash: null, pending: true}))).toEqual({status: 'pending'})
  })

  it('reports a send the wallet gave up on as discarded', () => {
    // The spec's own meaning: "failed to be included in chain, e.g. because of TTL". A node-level
    // rejection leaves no row anywhere, so absence past the window is the whole evidence.
    expect(txStatusOf(tx({hash: null, abandoned: true}))).toEqual({status: 'discarded'})
  })

  it('reports a full success as confirmed with an empty executionStatus', () => {
    // Faithful, not a gap: the indexer sends no per-segment detail exactly when nothing failed, so
    // "{}" says "no segment failed" — which is what happened.
    expect(txStatusOf(tx({outcome: {status: 'SUCCESS', segments: []}}))).toEqual({
      status: 'confirmed',
      executionStatus: {},
    })
  })

  it('maps named segments to their verdicts', () => {
    expect(
      txStatusOf(
        tx({
          outcome: {
            status: 'PARTIAL_SUCCESS',
            segments: [
              {id: 0, success: true},
              {id: 1, success: false},
            ],
          },
        }),
      ),
    ).toEqual({status: 'confirmed', executionStatus: {0: 'Success', 1: 'Failure'}})
  })

  it('reports a failure whose segments are named', () => {
    expect(txStatusOf(tx({outcome: {status: 'FAILURE', segments: [{id: 1, success: false}]}}))).toEqual({
      status: 'confirmed',
      executionStatus: {1: 'Failure'},
    })
  })

  it('refuses a failure with no named segments rather than reporting it as success', () => {
    // `confirmed` + `{}` would be indistinguishable from a full success — the one mapping that lies.
    expect(txStatusOf(tx({outcome: {status: 'FAILURE', segments: []}}))).toBeNull()
  })

  it('refuses a landed transaction the indexer reported no result for', () => {
    // Not pending (it is in a block) and not describable as confirmed (no status to report).
    expect(txStatusOf(tx())).toBeNull()
  })

  it('never claims finalized, because nothing here reports finality', () => {
    const statuses = [
      txStatusOf(tx({outcome: {status: 'SUCCESS', segments: []}})),
      txStatusOf(tx({hash: null, pending: true})),
      txStatusOf(tx({hash: null, abandoned: true})),
    ]

    expect(statuses.map((s) => s?.status)).toEqual(['confirmed', 'pending', 'discarded'])
  })

  it('treats abandoned as final even if a stale pending flag survives with it', () => {
    expect(txStatusOf(tx({hash: null, pending: true, abandoned: true}))).toEqual({status: 'discarded'})
  })
})

describe('historyEntriesOf', () => {
  it('keeps the describable rows, in order', () => {
    const entries = historyEntriesOf([
      tx({hash: 'aa', outcome: {status: 'SUCCESS', segments: []}}),
      tx({hash: 'bb', outcome: {status: 'FAILURE', segments: [{id: 1, success: false}]}}),
    ])

    expect(entries.map((e) => e.txHash)).toEqual(['aa', 'bb'])
  })

  it('drops a send in flight, because the API requires a hash it does not have', () => {
    const reasons: string[] = []

    const entries = historyEntriesOf([tx({hash: null, pending: true})], (r) => reasons.push(r))

    expect(entries).toEqual([])
    expect(reasons).toHaveLength(1)
  })

  it('drops an undescribable row and says why, so a short history is not silent', () => {
    const reasons: string[] = []

    const entries = historyEntriesOf(
      [tx({hash: 'aa'}), tx({hash: 'bb', outcome: {status: 'FAILURE', segments: []}})],
      (r) => reasons.push(r),
    )

    expect(entries).toEqual([])
    expect(reasons).toEqual([
      'no faithful status for aa: no result reported',
      'no faithful status for bb: a failure with no named segments',
    ])
  })

  it('does not require a reporter', () => {
    expect(() => historyEntriesOf([tx({hash: null, pending: true})])).not.toThrow()
  })
})
