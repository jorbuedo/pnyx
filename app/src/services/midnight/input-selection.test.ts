import {describe, expect, it} from 'vitest'

import {MAX_UNSHIELDED_INPUTS, selectUnshieldedInputs} from './input-selection'
import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'

const NIGHT = '0'.repeat(64)
const OTHER = '03'.repeat(32)

const utxo = (value: bigint, outputIndex: number, tokenType = NIGHT): UnshieldedUtxo => ({
  owner: 'mn_addr_preprod1ours',
  tokenType,
  value,
  intentHash: `${outputIndex}`.padStart(64, 'a'),
  outputIndex,
  ctime: null,
  registeredForDustGeneration: false,
})

const inputsOf = (selection: ReturnType<typeof selectUnshieldedInputs>): readonly UnshieldedUtxo[] =>
  selection.ok ? selection.inputs : []

describe('selectUnshieldedInputs', () => {
  it('takes the largest first, so the input count stays low', () => {
    const chosen = selectUnshieldedInputs([utxo(1n, 0), utxo(500n, 1), utxo(100n, 2)], NIGHT, 400n)
    expect(inputsOf(chosen).map((u) => u.value)).toEqual([500n])
  })

  it('keeps adding until the amount is covered', () => {
    const chosen = selectUnshieldedInputs([utxo(100n, 0), utxo(300n, 1), utxo(200n, 2)], NIGHT, 450n)
    expect(inputsOf(chosen).map((u) => u.value)).toEqual([300n, 200n])
  })

  it('covers an amount equal to the total exactly', () => {
    const chosen = selectUnshieldedInputs([utxo(100n, 0), utxo(200n, 1)], NIGHT, 300n)
    expect(inputsOf(chosen).map((u) => u.value)).toEqual([200n, 100n])
  })

  it('reports insufficient funds when the set cannot cover the amount', () => {
    expect(selectUnshieldedInputs([utxo(100n, 0)], NIGHT, 101n)).toEqual({ok: false, reason: 'insufficient'})
    expect(selectUnshieldedInputs([], NIGHT, 1n)).toEqual({ok: false, reason: 'insufficient'})
  })

  // Written against the ceiling rather than a literal count, so raising it stays a one-line change.
  // It has already moved once: four while the offer sat in the guaranteed segment, then 64 once the
  // per-input dust-generation cost stopped counting against dismissal.
  const fragmented = Array.from({length: MAX_UNSHIELDED_INPUTS + 5}, (_, i) => utxo(100n, i))
  const exactlyTheCeiling = 100n * BigInt(MAX_UNSHIELDED_INPUTS)

  /**
   * The failure that cost a real transfer: 46 inputs balanced cleanly and the node refused the
   * transaction, because the sponsor's fee calculation does not enforce the dismiss-time rule. See
   * MAX_UNSHIELDED_INPUTS for the ceiling and why it is where it is.
   */
  it('refuses an amount that needs more inputs than a transfer may carry', () => {
    expect(selectUnshieldedInputs(fragmented, NIGHT, exactlyTheCeiling + 1n)).toEqual({
      ok: false,
      reason: 'too-many-inputs',
    })
  })

  it('spends up to the ceiling and no further', () => {
    const chosen = selectUnshieldedInputs(fragmented, NIGHT, exactlyTheCeiling)
    expect(chosen.ok).toBe(true)
    expect(inputsOf(chosen)).toHaveLength(MAX_UNSHIELDED_INPUTS)
  })

  /** Holding too little and holding it in too many pieces are different problems. */
  it('separates a shortfall from a wallet that is merely fragmented', () => {
    const held = 100n * BigInt(fragmented.length)
    expect(selectUnshieldedInputs(fragmented, NIGHT, exactlyTheCeiling + 1n)).toEqual({
      ok: false,
      reason: 'too-many-inputs',
    })
    expect(selectUnshieldedInputs(fragmented, NIGHT, held + 1n)).toEqual({ok: false, reason: 'insufficient'})
  })

  /**
   * The expensive mistake: spending a UTxO of another token folds its value into this token's change,
   * which loses it. The native builder refuses the mix, but selection must not offer it one.
   */
  it('never selects a UTxO of another token', () => {
    const chosen = selectUnshieldedInputs([utxo(1_000n, 0, OTHER), utxo(50n, 1)], NIGHT, 40n)
    expect(inputsOf(chosen).map((u) => u.tokenType)).toEqual([NIGHT])
  })

  it('reports a shortfall rather than selecting another token to make up the difference', () => {
    expect(selectUnshieldedInputs([utxo(1_000n, 0, OTHER), utxo(50n, 1)], NIGHT, 100n)).toEqual({
      ok: false,
      reason: 'insufficient',
    })
  })

  it('refuses a non-positive amount instead of selecting nothing and succeeding', () => {
    expect(selectUnshieldedInputs([utxo(100n, 0)], NIGHT, 0n)).toEqual({ok: false, reason: 'insufficient'})
    expect(selectUnshieldedInputs([utxo(100n, 0)], NIGHT, -1n)).toEqual({ok: false, reason: 'insufficient'})
  })

  it("does not mutate the caller's list while sorting it", () => {
    const utxos = [utxo(1n, 0), utxo(500n, 1)]
    selectUnshieldedInputs(utxos, NIGHT, 400n)
    expect(utxos.map((u) => u.value)).toEqual([1n, 500n])
  })
})
