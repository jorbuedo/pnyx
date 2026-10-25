/**
 * The spread policy: aim for a target count, never below a useful chunk, never lose a STAR.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'

import {
  DEFAULT_NIGHT_SPREAD,
  dustCapForNight,
  minChunkForFees,
  type NightSpreadPolicy,
  planChangeSplit,
  STARS_PER_NIGHT,
} from './night-spread'

const policy = (over: Partial<NightSpreadPolicy> = {}): NightSpreadPolicy => ({
  targetUtxos: 30,
  minChunkStars: 2n * STARS_PER_NIGHT,
  maxChunksPerTx: 8,
  ...over,
})

const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n)

describe('the DUST a NIGHT holding can generate', () => {
  it('is five DUST per NIGHT at cap', () => {
    // The ledger's `night_dust_ratio: 5 * (SPECKS_PER_DUST / STARS_PER_NIGHT)`. If this figure moves,
    // every minimum below is wrong, which is why it is pinned rather than assumed.
    expect(dustCapForNight(STARS_PER_NIGHT)).toBe(5_000_000_000_000_000n)
  })

  it('derives the minimum chunk from the fee, rounding up', () => {
    // A chunk one STAR short of covering the fees asked for does not cover them.
    expect(minChunkForFees(5_000_000_000_001n, 1)).toBe(1_001n)
    expect(minChunkForFees(0n, 10)).toBe(0n)
    expect(minChunkForFees(1_000n, 0)).toBe(0n)
  })

  it('sizes the default so a chunk covers ten of the measured fee', () => {
    const chunk = DEFAULT_NIGHT_SPREAD.minChunkStars
    expect(dustCapForNight(chunk)).toBeGreaterThanOrEqual(686_161_378_353_573n * 10n)
  })
})

describe('planning a change split', () => {
  it('splits toward the target when the change can afford it', () => {
    const chunks = planChangeSplit({
      changeStars: 100n * STARS_PER_NIGHT,
      utxosAfterExcludingChange: 1,
      policy: policy(),
    })
    // Wants 29 more, can afford 50 at 2 NIGHT each, capped at 8 per transaction.
    expect(chunks).toHaveLength(8)
    expect(sum(chunks)).toBe(100n * STARS_PER_NIGHT)
  })

  it('never creates a chunk below the useful minimum', () => {
    // ⚠️ The rule that stops "aim for 30" becoming "fragment into 30". 5 NIGHT at a 2-NIGHT minimum is
    // two chunks, not eight — a chunk whose DUST cap cannot cover a fee buys no payer.
    const chunks = planChangeSplit({
      changeStars: 5n * STARS_PER_NIGHT,
      utxosAfterExcludingChange: 0,
      policy: policy(),
    })
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) expect(chunk).toBeGreaterThanOrEqual(2n * STARS_PER_NIGHT)
  })

  it('does not split at all when the change is below one useful chunk', () => {
    const chunks = planChangeSplit({
      changeStars: STARS_PER_NIGHT,
      utxosAfterExcludingChange: 0,
      policy: policy(),
    })
    expect(chunks).toEqual([STARS_PER_NIGHT])
  })

  it('stops splitting once the wallet is at its target', () => {
    // The change output is itself one of the UTxOs we want, so at target there is nothing to do.
    expect(
      planChangeSplit({changeStars: 100n * STARS_PER_NIGHT, utxosAfterExcludingChange: 30, policy: policy()}),
    ).toEqual([100n * STARS_PER_NIGHT])
    expect(
      planChangeSplit({changeStars: 100n * STARS_PER_NIGHT, utxosAfterExcludingChange: 29, policy: policy()}),
    ).toEqual([100n * STARS_PER_NIGHT])
  })

  it('honours a larger target, which is what a sponsor wallet needs', () => {
    // A sponsor funds many users' transactions at once, so it needs more simultaneous payers than a
    // personal wallet — the target is a property of the wallet's job, not of the chain.
    const chunks = planChangeSplit({
      changeStars: 1_000n * STARS_PER_NIGHT,
      utxosAfterExcludingChange: 20,
      policy: policy({targetUtxos: 200, maxChunksPerTx: 40}),
    })
    expect(chunks).toHaveLength(40)
    expect(sum(chunks)).toBe(1_000n * STARS_PER_NIGHT)
  })

  it('conserves every STAR, remainder included', () => {
    // An indivisible remainder goes to the first chunk. Spreading it would need fractional STARS, and
    // dropping it would burn value the transaction was conserving.
    const change = 100n * STARS_PER_NIGHT + 7n
    const chunks = planChangeSplit({changeStars: change, utxosAfterExcludingChange: 0, policy: policy()})
    expect(sum(chunks)).toBe(change)
    expect(chunks[0]).toBeGreaterThan(chunks[1] ?? 0n)
  })

  it('returns nothing when there is no change', () => {
    expect(planChangeSplit({changeStars: 0n, utxosAfterExcludingChange: 0, policy: policy()})).toEqual([])
  })
})
