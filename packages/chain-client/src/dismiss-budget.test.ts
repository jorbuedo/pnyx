import {describe, expect, it} from 'vitest'
import {assessDismissBudget, type FeeAssessable} from './dismiss-budget.js'

/** A transaction whose `fees` behaves however a test needs, recording how it was called. */
const txThat = (behaviour: () => bigint): FeeAssessable & {calls: {enforce: boolean | undefined}[]} => {
  const calls: {enforce: boolean | undefined}[] = []
  return {
    calls,
    fees: (_params: unknown, enforceTimeToDismiss?: boolean) => {
      calls.push({enforce: enforceTimeToDismiss})
      return behaviour()
    },
  }
}

const PARAMS = {marker: 'ledger-parameters'}

describe('assessDismissBudget', () => {
  it('accepts a transaction the rule prices, and reports the fee', () => {
    const tx = txThat(() => 1_234n)

    expect(assessDismissBudget(tx, PARAMS)).toEqual({kind: 'ok', fee: 1_234n})
  })

  it('enforces the dismiss-time rule — the whole point is the second argument', () => {
    const tx = txThat(() => 1n)

    assessDismissBudget(tx, PARAMS)

    // `cost(params, false)` is what balancing already did; asking again without enforcement would
    // re-answer the question that never fails and refuse nothing.
    expect(tx.calls).toEqual([{enforce: true}])
  })

  it('refuses when the ledger rejects the assembled transaction, quoting its reason', () => {
    const tx = txThat(() => {
      throw new Error('Custom error: 168')
    })

    const verdict = assessDismissBudget(tx, PARAMS)

    expect(verdict.kind).toBe('refuse')
    // The ledger's own message survives: a refusal whose reason is ours and not the chain's is a
    // refusal nobody can act on.
    expect(verdict.kind === 'refuse' && verdict.reason).toContain('Custom error: 168')
  })

  it('does NOT refuse on the transient fee-pricing panic — that would make a retryable failure permanent', () => {
    const tx = txThat(() => {
      throw new Error(
        "Wallet.Other: Unreachable code should not be executed (evaluating 'wasm.transaction_feesWithMargin(...)')",
      )
    })

    const verdict = assessDismissBudget(tx, PARAMS)

    expect(verdict.kind).toBe('unpriceable')
    expect(verdict.kind === 'unpriceable' && verdict.reason).toContain('Unreachable code')
  })

  it('reports a non-Error throw rather than losing it', () => {
    const tx = txThat(() => {
      throw 'a bare string from the WASM boundary'
    })

    const verdict = assessDismissBudget(tx, PARAMS)

    expect(verdict.kind).toBe('refuse')
    expect(verdict.kind === 'refuse' && verdict.reason).toContain('a bare string from the WASM boundary')
  })
})
