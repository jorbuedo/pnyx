import {describe, expect, it} from 'vitest'
import type {BalanceTimeline} from './balance-timeline'
import {ADA_KEY} from './balance-timeline'
import {portfolioAt, type SnapshotMeta} from './portfolio-snapshot'

const NIGHT = 'policy1.4e494748'
const GENS = 'policy2.47454e53'

/** The repro wallet: ADA throughout, NIGHT until the swap at t=200, GENS after it. */
const timeline: BalanceTimeline = new Map([
  [ADA_KEY, [{ts: 100, balance: 1_000_000n}]],
  [
    NIGHT,
    [
      {ts: 100, balance: 500n},
      {ts: 200, balance: 0n},
    ],
  ],
  [GENS, [{ts: 200, balance: 900n}]],
])

const meta =
  (decimals: number | null = 0): ((key: string) => SnapshotMeta) =>
  (key) => ({label: key === ADA_KEY ? 'ADA' : key === NIGHT ? 'NIGHT' : 'GENS', decimals})

const priced = (unit: number) => () => unit
const unpriced = () => null

const labels = (rows: readonly {label: string}[]) => rows.map((r) => r.label).sort()

describe('portfolioAt', () => {
  it('lists an asset held then but not now', () => {
    const rows = portfolioAt(timeline, 150, meta(), priced(2), new Set())
    expect(labels(rows)).toEqual(['ADA', 'NIGHT'])
  })

  it('omits an asset acquired later rather than showing today’s balance', () => {
    const rows = portfolioAt(timeline, 150, meta(), priced(2), new Set())
    expect(rows.find((r) => r.id === GENS)).toBeUndefined()
  })

  it('swaps one for the other across the trade', () => {
    expect(labels(portfolioAt(timeline, 250, meta(), priced(2), new Set()))).toEqual(['ADA', 'GENS'])
  })

  // The balance is the whole point: a zero balance is not a holding, so the row does not exist.
  it('drops an asset whose balance is zero at that instant', () => {
    const rows = portfolioAt(timeline, 200, meta(), priced(2), new Set())
    expect(rows.find((r) => r.id === NIGHT)).toBeUndefined()
  })

  it('is empty before the wallet held anything', () => {
    expect(portfolioAt(timeline, 50, meta(), priced(2), new Set())).toEqual([])
  })

  it('values a row at that instant, not at the tip', () => {
    const row = portfolioAt(timeline, 150, meta(0), priced(3), new Set()).find((r) => r.id === NIGHT)
    expect(row?.quantity).toBe(500n)
    expect(row?.fiatValue).toBe(1500)
  })

  it('scales by the asset’s decimals', () => {
    const row = portfolioAt(timeline, 150, meta(2), priced(1), new Set()).find((r) => r.id === NIGHT)
    // 500 base units at 2 decimals = 5 whole tokens.
    expect(row?.fiatValue).toBe(5)
  })

  // Failing to price something is not evidence it was not held — it still appears, unpriced, which is
  // the tier the live list already renders.
  it('keeps an unpriced asset, with a null value', () => {
    const row = portfolioAt(timeline, 150, meta(), unpriced, new Set()).find((r) => r.id === NIGHT)
    expect(row).toBeDefined()
    expect(row?.fiatValue).toBeNull()
  })

  // Same rule the aggregate follows: an unknown scale refuses to price rather than mis-scaling by
  // orders of magnitude.
  it('refuses to value an asset with no known scale', () => {
    const row = portfolioAt(timeline, 150, meta(null), priced(2), new Set()).find((r) => r.id === NIGHT)
    expect(row?.decimals).toBeNull()
    expect(row?.fiatValue).toBeNull()
    expect(row?.quantity).toBe(500n)
  })

  it('marks ADA as ADA and everything else not', () => {
    const rows = portfolioAt(timeline, 150, meta(), priced(2), new Set())
    expect(rows.find((r) => r.id === ADA_KEY)?.isAda).toBe(true)
    expect(rows.find((r) => r.id === NIGHT)?.isAda).toBe(false)
  })

  // A single indivisible unit of an undocumented token is what an NFT looks like from outside, and the
  // live list's own heuristic decides — so a scrubbed list filters by type identically.
  it('classifies a lone indivisible unverified unit as an NFT', () => {
    const one: BalanceTimeline = new Map([[NIGHT, [{ts: 100, balance: 1n}]]])
    expect(portfolioAt(one, 150, meta(0), unpriced, new Set())[0]?.isNft).toBe(true)
    expect(portfolioAt(one, 150, meta(0), unpriced, new Set([NIGHT]))[0]?.isNft).toBe(false)
  })

  // A partial local history can leave a negative running balance (see anchorTimeline); that is not a
  // holding either.
  it('treats a negative balance as not held', () => {
    const partial: BalanceTimeline = new Map([[NIGHT, [{ts: 100, balance: -5n}]]])
    expect(portfolioAt(partial, 150, meta(), priced(2), new Set())).toEqual([])
  })
})
