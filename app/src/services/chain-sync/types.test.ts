import type {StoredTransaction} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {computeNativeBalanceDelta} from './types'

const tx = (overrides: Partial<StoredTransaction>): StoredTransaction => ({
  hash: overrides.hash ?? 'h',
  direction: overrides.direction ?? 'received',
  amount: overrides.amount ?? '0',
  status: overrides.status ?? 'confirmed',
  ...overrides,
})

describe('computeNativeBalanceDelta', () => {
  it('returns 0n when no new transactions', () => {
    const txs = [tx({hash: 'a', direction: 'received', amount: '10'})]
    expect(computeNativeBalanceDelta(txs, 1)).toBe(0n)
  })

  it('returns 0n when transactions.length < existingTxCount', () => {
    const txs = [tx({hash: 'a', direction: 'received', amount: '10'})]
    expect(computeNativeBalanceDelta(txs, 2)).toBe(0n)
  })

  it('adds amount for a native received tx', () => {
    const txs = [tx({hash: 'a', direction: 'received', amount: '100', timestamp: '2025-01-01T00:00:00Z'})]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(100n)
  })

  it('does not add amount for a token received tx (contractAddress set)', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'received',
        amount: '100',
        timestamp: '2025-01-01T00:00:00Z',
        metadata: {contractAddress: '0xabc'},
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(0n)
  })

  it('subtracts amount + fee for a native sent tx', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'sent',
        amount: '100',
        fee: '5',
        timestamp: '2025-01-01T00:00:00Z',
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(-105n)
  })

  it('subtracts only fee for a token sent tx', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'sent',
        amount: '100',
        fee: '5',
        timestamp: '2025-01-01T00:00:00Z',
        metadata: {contractAddress: '0xabc'},
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(-5n)
  })

  it('subtracts fee for self transfer', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'self',
        amount: '50',
        fee: '3',
        timestamp: '2025-01-01T00:00:00Z',
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(-3n)
  })

  it('only counts the newest N transactions when existingTxCount > 0', () => {
    const txs: readonly StoredTransaction[] = [
      tx({hash: 'old1', direction: 'received', amount: '1', timestamp: '2025-01-01T00:00:00Z'}),
      tx({hash: 'old2', direction: 'received', amount: '2', timestamp: '2025-01-02T00:00:00Z'}),
      tx({hash: 'new', direction: 'sent', amount: '10', fee: '1', timestamp: '2025-01-03T00:00:00Z'}),
    ]
    // existingTxCount = 2 → only the newest 1 ("new") should be counted
    expect(computeNativeBalanceDelta(txs, 2)).toBe(-11n)
  })

  it('sorts by timestamp descending regardless of input order', () => {
    const txs: readonly StoredTransaction[] = [
      tx({hash: 'newest', direction: 'sent', amount: '10', fee: '1', timestamp: '2025-01-03T00:00:00Z'}),
      tx({hash: 'oldest', direction: 'received', amount: '5', timestamp: '2025-01-01T00:00:00Z'}),
      tx({hash: 'middle', direction: 'received', amount: '7', timestamp: '2025-01-02T00:00:00Z'}),
    ]
    // existingTxCount = 2 → newest one is the send. delta = -(10 + 1) = -11
    expect(computeNativeBalanceDelta(txs, 2)).toBe(-11n)
  })

  it('treats transactions with no timestamp as oldest', () => {
    const txs: readonly StoredTransaction[] = [
      tx({hash: 'untimed', direction: 'received', amount: '50'}),
      tx({hash: 'timed', direction: 'sent', amount: '10', fee: '1', timestamp: '2025-01-03T00:00:00Z'}),
    ]
    // existingTxCount = 1 → newest by timestamp DESC is "timed". delta = -11.
    expect(computeNativeBalanceDelta(txs, 1)).toBe(-11n)
  })

  it('handles missing fee as 0', () => {
    const txs = [tx({hash: 'a', direction: 'sent', amount: '100', timestamp: '2025-01-01T00:00:00Z'})]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(-100n)
  })

  it('handles malformed amount/fee as 0n', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'sent',
        amount: 'not-a-number',
        fee: 'also-bad',
        timestamp: '2025-01-01T00:00:00Z',
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(0n)
  })

  it('treats empty string contractAddress as native (not token)', () => {
    const txs = [
      tx({
        hash: 'a',
        direction: 'received',
        amount: '42',
        timestamp: '2025-01-01T00:00:00Z',
        metadata: {contractAddress: ''},
      }),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(42n)
  })

  it('aggregates deltas across multiple new transactions', () => {
    const txs: readonly StoredTransaction[] = [
      tx({hash: 'a', direction: 'received', amount: '100', timestamp: '2025-01-01T00:00:00Z'}),
      tx({hash: 'b', direction: 'sent', amount: '30', fee: '2', timestamp: '2025-01-02T00:00:00Z'}),
      tx({hash: 'c', direction: 'self', amount: '5', fee: '1', timestamp: '2025-01-03T00:00:00Z'}),
    ]
    // existingTxCount = 0 → all are new. delta = +100 - 32 - 1 = 67
    expect(computeNativeBalanceDelta(txs, 0)).toBe(67n)
  })

  it('can produce a negative aggregate delta (caller must guard before applying)', () => {
    // Regression for negative balance bug: when sends among new txs exceed
    // receives, the delta is negative — call sites must clamp before assigning.
    const txs: readonly StoredTransaction[] = [
      tx({hash: 'a', direction: 'sent', amount: '100', fee: '5', timestamp: '2025-01-01T00:00:00Z'}),
    ]
    expect(computeNativeBalanceDelta(txs, 0)).toBe(-105n)
  })
})
