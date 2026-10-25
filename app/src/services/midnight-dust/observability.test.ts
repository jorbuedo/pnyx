import {describe, expect, it} from 'vitest'
import {
  DUST_DECIMALS,
  type DustGenerationRow,
  NIGHT_DECIMALS,
  parseDustGeneration,
  toObservedDust,
} from './observability'

/**
 * Rows captured verbatim from the live mainnet indexer on 2026-07-28, for the same four
 * wallets the health states were verified against. Real rows rather than invented ones: the
 * shape of what the API actually sends is the thing most likely to drift.
 */
const LIVE = {
  generating: {
    registered: true,
    dustAddress: 'mn_dust1wdtqefv2fq3jrgq2h7gt2ah9sul5t6pnwcvy8hzn0c8uwyzelxcxq4lfq5k',
    nightBalance: '36505016',
    generationRate: '301786967272',
    currentCapacity: '182525080000000000',
    maxCapacity: '182525080000000000',
  },
  zeroBalance: {
    registered: true,
    dustAddress: 'mn_dust1w0kp6y2dq0m5crdqvd3tcyve6dd2hy2kllm6j28yqfz3h3m0fltr2efy63w',
    nightBalance: '0',
    generationRate: '0',
    currentCapacity: '0',
    maxCapacity: '0',
  },
  /** A wallet with TWO registrations. The indexer reports it as unregistered. */
  multiRegistered: {
    registered: false,
    nightBalance: '0',
    generationRate: '0',
    currentCapacity: '0',
    maxCapacity: '0',
  },
} satisfies Record<string, DustGenerationRow>

describe('parseDustGeneration', () => {
  it('reads a live generating row', () => {
    const gen = parseDustGeneration(LIVE.generating)
    expect(gen.eligibleNightStars).toBe(36_505_016n)
    expect(gen.generationRateSpecks).toBe(301_786_967_272n)
    expect(gen.currentCapacitySpecks).toBe(182_525_080_000_000_000n)
  })

  it('agrees with the documented tokenomics constants', () => {
    // spec/dust.md: 8,267 Specks/Star/sec, and a 5 DUST per NIGHT cap. If either the units or
    // the field meanings drift, this is where it shows — the live row reproduces both exactly.
    const gen = parseDustGeneration(LIVE.generating)
    const stars = gen.eligibleNightStars as bigint
    expect(gen.generationRateSpecks).toBe(stars * 8_267n)
    expect(gen.maxCapacitySpecks).toBe(stars * 5n * 10n ** BigInt(DUST_DECIMALS - NIGHT_DECIMALS))
  })

  it('keeps a real zero as zero', () => {
    expect(parseDustGeneration(LIVE.zeroBalance).eligibleNightStars).toBe(0n)
  })

  it('reports an omitted field as absent, never as zero', () => {
    // Absent and zero lead to opposite conclusions: one is "no eligible NIGHT" (a diagnosis),
    // the other is "we were not told" (no diagnosis).
    const gen = parseDustGeneration({registered: true})
    expect(gen.eligibleNightStars).toBeNull()
    expect(gen.generationRateSpecks).toBeNull()
  })

  it('refuses a value that is not a plain integer', () => {
    const gen = parseDustGeneration({registered: true, nightBalance: '1.5', generationRate: 'lots'})
    expect(gen.eligibleNightStars).toBeNull()
    expect(gen.generationRateSpecks).toBeNull()
  })
})

describe('toObservedDust', () => {
  it('reports accrual and eligible NIGHT from a generating row', () => {
    const obs = toObservedDust({kind: 'ok', row: LIVE.generating})
    expect(obs).toEqual({accruing: true, cursorSlot: null, eligibleNight: 36_505_016n})
  })

  it('reports a registered wallet with no eligible NIGHT as not accruing', () => {
    const obs = toObservedDust({kind: 'ok', row: LIVE.zeroBalance})
    expect(obs?.accruing).toBe(false)
    expect(obs?.eligibleNight).toBe(0n)
  })

  it('observes nothing for a multiply-registered wallet, which reads back as unregistered', () => {
    // The Proposal-0018 trap, live: believing `registered: false` here would let the screen
    // offer a *third* registration to a wallet already broken by having two. The Cardano scan
    // is what knows the difference, so the indexer contributes nothing in this case.
    expect(toObservedDust({kind: 'ok', row: LIVE.multiRegistered})).toBeNull()
  })

  it('observes nothing when the indexer is unreachable or knows of no registration', () => {
    expect(toObservedDust({kind: 'unavailable'})).toBeNull()
    expect(toObservedDust({kind: 'none'})).toBeNull()
  })

  it('omits eligibleNight rather than defaulting it when the field is absent', () => {
    const obs = toObservedDust({kind: 'ok', row: {registered: true, generationRate: '1'}})
    expect(obs?.accruing).toBe(true)
    expect(obs && 'eligibleNight' in obs).toBe(false)
  })

  it('leaves cursorSlot null, since the v4 schema exposes no Cardano-side cursor', () => {
    // Passing 0 would read as "inside the lag window" and give the right answer by accident.
    expect(toObservedDust({kind: 'ok', row: LIVE.generating})?.cursorSlot).toBeNull()
  })
})
