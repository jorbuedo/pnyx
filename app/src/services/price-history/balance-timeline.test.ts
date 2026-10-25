import type {ReviewedAmount, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {ADA_KEY, anchorTimeline, balanceAt, buildBalanceTimeline, heldAssetKeys, heldWindow} from './balance-timeline'

const NIGHT = 'nightpolicy.4e49474854'
const iso = (sec: number) => new Date(sec * 1000).toISOString()

const tx = (
  sec: number,
  ownDelta: ReviewedAmount[],
  status: 'confirmed' | 'pending' | 'failed' = 'confirmed',
): ReviewedTransaction => ({chain: 'cardano', timestamp: iso(sec), status, ownDelta}) as unknown as ReviewedTransaction

describe('buildBalanceTimeline', () => {
  const txs = [
    tx(1000, [{quantity: 10_000000n}]), // +10 ADA
    tx(2000, [{quantity: 5_000000n}, {assetId: NIGHT, quantity: 100_000000n}]), // +5 ADA, +100 NIGHT
    tx(3000, [{quantity: -3_000000n}]), // -3 ADA → 12 ADA
  ]
  const tl = buildBalanceTimeline(txs)

  it('accumulates per-asset cumulative balances', () => {
    expect(balanceAt(tl, ADA_KEY, 1500)).toBe(10_000000n)
    expect(balanceAt(tl, ADA_KEY, 2500)).toBe(15_000000n)
    expect(balanceAt(tl, ADA_KEY, 3000)).toBe(12_000000n)
    expect(balanceAt(tl, NIGHT, 2500)).toBe(100_000000n)
  })

  it('is zero before the first tx', () => {
    expect(balanceAt(tl, ADA_KEY, 500)).toBe(0n)
    expect(balanceAt(tl, NIGHT, 1500)).toBe(0n)
  })

  it('lists held keys and held windows', () => {
    expect([...heldAssetKeys(tl)].sort()).toEqual([ADA_KEY, NIGHT].sort())
    expect(heldWindow(tl, ADA_KEY)).toEqual({fromSec: 1000, toSec: 3000})
    expect(heldWindow(tl, NIGHT)).toEqual({fromSec: 2000, toSec: 2000})
  })

  it('skips failed txs and collapses same-second deltas', () => {
    const t = buildBalanceTimeline([
      tx(1000, [{quantity: 1_000000n}]),
      tx(1000, [{quantity: 2_000000n}]), // same second → collapses to running total
      tx(2000, [{quantity: 9_000000n}], 'failed'), // ignored
    ])
    expect(balanceAt(t, ADA_KEY, 1000)).toBe(3_000000n)
    expect(balanceAt(t, ADA_KEY, 5000)).toBe(3_000000n) // failed tx had no effect
    expect(t.get(ADA_KEY)).toHaveLength(1)
  })
})

describe('anchorTimeline', () => {
  // Partial history: raw cumulative tip is 15 ADA, but the wallet really holds
  // 1000 ADA now (early funding txs never synced). Anchor lifts the whole curve.
  const partial = buildBalanceTimeline([tx(2000, [{quantity: 5_000000n}]), tx(3000, [{quantity: 10_000000n}])])

  it('shifts the series so the tip equals the current on-chain balance', () => {
    const anchored = anchorTimeline(partial, new Map([[ADA_KEY, 1000_000000n]]), 1000)
    expect(balanceAt(anchored, ADA_KEY, 5000)).toBe(1000_000000n) // tip = current
    // Earlier point reconstructs backward: 1000 − (10 received at t=3000) = 990.
    expect(balanceAt(anchored, ADA_KEY, 2500)).toBe(990_000000n)
  })

  it('corrects an inverted (negative) raw tip to the real positive balance', () => {
    // Raw history nets to −27 (only outflows synced); real holding is +27.
    const inverted = buildBalanceTimeline([tx(2000, [{assetId: NIGHT, quantity: -27_000000n}])])
    const anchored = anchorTimeline(inverted, new Map([[NIGHT, 27_000000n]]), 1000)
    expect(balanceAt(anchored, NIGHT, 5000)).toBe(27_000000n)
  })

  it('synthesizes a flat step for a held asset with no history', () => {
    const anchored = anchorTimeline(new Map(), new Map([[NIGHT, 42_000000n]]), 1234)
    expect(balanceAt(anchored, NIGHT, 5000)).toBe(42_000000n)
    expect(balanceAt(anchored, NIGHT, 1000)).toBe(0n) // before the synthetic floor
    expect(anchored.get(NIGHT)).toEqual([{ts: 1234, balance: 42_000000n}])
  })

  it('passes through assets absent from the current-balance map unchanged', () => {
    const anchored = anchorTimeline(partial, new Map(), 1000)
    expect(anchored.get(ADA_KEY)).toEqual(partial.get(ADA_KEY))
  })

  it('is a no-op offset when the raw tip already matches current', () => {
    const anchored = anchorTimeline(partial, new Map([[ADA_KEY, 15_000000n]]), 1000)
    expect(anchored.get(ADA_KEY)).toBe(partial.get(ADA_KEY)) // same reference, no rebuild
  })
})
