import type {ReviewedAmount, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import type {FiatAtTime} from '../../hooks/useCardanoPortfolioHistory'
import {buildActivityCsv} from './activity-csv'

const NIGHT = 'nightpolicy.4e49474854'
const iso = (sec: number) => new Date(sec * 1000).toISOString()

const emptyGroup = {entries: [], deltas: [], parties: []}

// `activityType` (via buildActivityCsv) reads the IO lists and the party tiers as
// well as `operations`, so the fixture carries the empty ones a real IR always has.
const tx = (sec: number | undefined, ownDelta: ReviewedAmount[], hash = 'abc'): ReviewedTransaction =>
  ({
    chain: 'cardano',
    hash,
    timestamp: sec === undefined ? undefined : iso(sec),
    status: 'confirmed',
    ownDelta,
    operations: [],
    inputs: [],
    outputs: [],
    ownGroup: emptyGroup,
    identityGroup: emptyGroup,
    escrowGroup: emptyGroup,
    otherGroup: emptyGroup,
  }) as unknown as ReviewedTransaction

const infoOf = (assetId: string | undefined) =>
  assetId === undefined ? {ticker: 'ADA', decimals: 6} : {ticker: 'NIGHT', decimals: 6}

// ADA = $0.50/whole unit; NIGHT unpriced (null).
const fiatOf: FiatAtTime = (assetKey, rawQuantity, decimals) =>
  assetKey.length === 0 ? {value: (Number(rawQuantity) / 10 ** decimals) * 0.5, currency: 'USD'} : null

const deps = {
  infoOf,
  fiatOf,
  currency: 'USD',
  cip113: {scriptCredentials: new Set<string>(), plbScriptHashHex: null, registryPolicyHex: null},
  formatDate: (ms: number) => `D${Math.floor(ms / 1000)}`,
}

describe('buildActivityCsv', () => {
  it('emits a header + one row per priced leg with unit price and signed value', () => {
    const csv = buildActivityCsv([tx(1000, [{quantity: 10_000000n}])], deps)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Date,Type,Asset,Amount,Unit price (USD),Value (USD),Tx hash')
    // 10 ADA received @ $0.50 → amount 10, unit 0.5, value 5.
    expect(lines[1]).toBe('D1000,received,ADA,10,0.5,5,abc')
  })

  it('signs a negative (sent) amount and value', () => {
    const csv = buildActivityCsv([tx(1000, [{quantity: -4_000000n}])], deps)
    expect(csv.split('\r\n')[1]).toBe('D1000,sent,ADA,-4,0.5,-2,abc')
  })

  it('leaves price/value blank for an unpriced leg (never a fabricated 0)', () => {
    const csv = buildActivityCsv([tx(1000, [{assetId: NIGHT, quantity: 100_000000n}])], deps)
    expect(csv.split('\r\n')[1]).toBe('D1000,received,NIGHT,100,,,abc')
  })

  it('emits one row per leg and skips zero-quantity legs', () => {
    const csv = buildActivityCsv([tx(1000, [{quantity: 3_000000n}, {assetId: NIGHT, quantity: 0n}])], deps)
    expect(csv.split('\r\n')).toHaveLength(2) // header + 1 leg (the 0-qty NIGHT leg dropped)
  })

  it('skips pending (timestamp-less) txs', () => {
    const csv = buildActivityCsv([tx(undefined, [{quantity: 1_000000n}])], deps)
    expect(csv.split('\r\n')).toHaveLength(1) // header only
  })
})
