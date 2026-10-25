import type {TxDeficit} from '@pnyx/midnight-native'
import {describe, expect, it} from 'vitest'

import {fundingCandidatesFor} from './fund-candidates'
import {MAX_UNSHIELDED_INPUTS} from './input-selection'
import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'

const NIGHT = '00'.repeat(32)
const OTHER = '07'.repeat(32)

const utxo = (value: bigint, index: number, tokenType = NIGHT): UnshieldedUtxo => ({
  owner: 'mn_addr_preprod1ours',
  tokenType,
  value,
  intentHash: index.toString(16).padStart(64, '0'),
  outputIndex: index,
  ctime: null,
  registeredForDustGeneration: false,
})

const deficit = (owed: bigint, segment = 1, tokenType: string | null = NIGHT, kind: TxDeficit['kind'] = 'unshielded') =>
  ({kind, tokenType, segment, owed}) as TxDeficit

describe('fundingCandidatesFor', () => {
  it('offers the token’s UTxOs largest first', () => {
    const result = fundingCandidatesFor([utxo(10n, 0), utxo(900n, 1), utxo(50n, 2)], [deficit(100n)])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates.map((c) => c.value)).toEqual([900n, 50n, 10n])
  })

  it('offers only the tokens that are actually owed', () => {
    // Offering a token nothing is short of would put UTxOs in front of a funder with no use for them.
    const result = fundingCandidatesFor([utxo(100n, 0), utxo(100n, 1, OTHER)], [deficit(50n)])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates.map((c) => c.tokenType)).toEqual([NIGHT])
  })

  it('offers candidates for every token that is owed', () => {
    const result = fundingCandidatesFor([utxo(100n, 0), utxo(100n, 1, OTHER)], [deficit(50n), deficit(40n, 1, OTHER)])

    expect(result.ok).toBe(true)
    if (result.ok) expect(new Set(result.candidates.map((c) => c.tokenType))).toEqual(new Set([NIGHT, OTHER]))
  })

  it('sums a token owed in two segments, because both are funded from the same wallet', () => {
    // 60 + 60 needs 120, and a set that only covers the larger leg would be refused after approval.
    const enough = fundingCandidatesFor([utxo(120n, 0)], [deficit(60n, 1), deficit(60n, 2)])
    expect(enough.ok).toBe(true)

    const notEnough = fundingCandidatesFor([utxo(100n, 0)], [deficit(60n, 1), deficit(60n, 2)])
    expect(notEnough.ok).toBe(false)
    if (!notEnough.ok) expect(notEnough.shortfall.owed).toBe(120n)
  })

  it('reports a genuine shortage as insufficient, with both figures', () => {
    const result = fundingCandidatesFor([utxo(40n, 0)], [deficit(100n)])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.shortfall).toEqual({tokenType: NIGHT, owed: 100n, reason: 'insufficient', held: 40n})
    }
  })

  it('reports money spread too thin as too-many-inputs, not as missing money', () => {
    // The remedy is consolidation. Calling this "insufficient" sends someone looking for funds they hold.
    const dust = Array.from({length: MAX_UNSHIELDED_INPUTS + 20}, (_, i) => utxo(10n, i))
    const result = fundingCandidatesFor(dust, [deficit(BigInt(dust.length) * 10n)])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.shortfall.reason).toBe('too-many-inputs')
      expect(result.shortfall.held).toBe(BigInt(dust.length) * 10n)
    }
  })

  it('never offers more inputs than one transaction may carry', () => {
    const many = Array.from({length: MAX_UNSHIELDED_INPUTS + 30}, (_, i) => utxo(1_000n, i))
    const result = fundingCandidatesFor(many, [deficit(500n)])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates.length).toBeLessThanOrEqual(MAX_UNSHIELDED_INPUTS)
  })

  it('ignores a shielded deficit rather than trying to cover it with unshielded UTxOs', () => {
    // It is refused natively, naming which. Treating it as fundable here would hide that refusal.
    const result = fundingCandidatesFor([utxo(100n, 0)], [deficit(50n, 1, NIGHT, 'shielded')])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates).toEqual([])
  })

  it('ignores a DUST deficit, which has no token type and is the sponsor’s anyway', () => {
    const result = fundingCandidatesFor([utxo(100n, 0)], [deficit(50n, 0, null, 'dust')])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates).toEqual([])
  })

  it('offers nothing when nothing is owed', () => {
    expect(fundingCandidatesFor([utxo(100n, 0)], [])).toEqual({ok: true, candidates: []})
  })

  it('reports an empty wallet as insufficient rather than offering nothing', () => {
    const result = fundingCandidatesFor([], [deficit(1n)])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.shortfall).toEqual({tokenType: NIGHT, owed: 1n, reason: 'insufficient', held: 0n})
  })

  it('covers an exact amount', () => {
    expect(fundingCandidatesFor([utxo(100n, 0)], [deficit(100n)]).ok).toBe(true)
  })
})
