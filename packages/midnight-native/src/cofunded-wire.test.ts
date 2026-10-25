// The co-funding wire format. Both sides of this are fixed-width, and the native side reads back
// what these functions write — so a width that drifts here fails at a boundary no other test covers.
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  CONTRIBUTION_HEADER_LEN,
  type CoFundContribution,
  packCoFundContributions,
  packCoFundShares,
  SHARE_RECORD_LEN,
  unpackCoFundShares,
} from './cofunded-wire'
import {INPUT_RECORD_LEN, type UnshieldedSpend} from './unshielded-wire'

const spend = (value: bigint, outputIndex: number): UnshieldedSpend => ({
  value,
  tokenType: new Uint8Array(32),
  intentHash: new Uint8Array(32).fill(outputIndex + 1),
  outputIndex,
})

const contribution = (owner: number, inputs: readonly UnshieldedSpend[], contributes: bigint): CoFundContribution => ({
  owner: new Uint8Array(32).fill(owner),
  inputs,
  contributes,
})

describe('packCoFundContributions', () => {
  it('writes a header plus that contributor’s input records, per contributor', () => {
    const hex = packCoFundContributions([
      contribution(1, [spend(3_000_000n, 0)], 2_000_000n),
      contribution(2, [spend(5_000_000n, 1), spend(1_000_000n, 2)], 4_000_000n),
    ])
    const expected = 2 * CONTRIBUTION_HEADER_LEN + 3 * INPUT_RECORD_LEN
    expect(hex.length).toBe(expected * 2)
  })

  it('writes the pledge and the input count little-endian, where Rust reads them', () => {
    const hex = packCoFundContributions([contribution(1, [spend(3_000_000n, 0)], 2_000_000n)])
    const bytes = Uint8Array.from((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)))
    // owner is 32 bytes of 1s
    expect([...bytes.slice(0, 32)].every((b) => b === 1)).toBe(true)
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    // pledge: 2_000_000 as u128 LE — the low 8 bytes carry it
    expect(view.getBigUint64(32, true)).toBe(2_000_000n)
    expect(view.getUint32(48, true)).toBe(1)
  })

  it('refuses a contributor with no inputs, rather than packing a fundless pledge', () => {
    expect(() => packCoFundContributions([contribution(1, [], 1n)])).toThrow(/no inputs/)
  })

  it('refuses an empty round', () => {
    expect(() => packCoFundContributions([])).toThrow(/at least one contributor/)
  })

  it('refuses an owner that is not 32 bytes — it is a key, not an address', () => {
    const bad = {owner: new Uint8Array(20), inputs: [spend(1n, 0)], contributes: 1n}
    expect(() => packCoFundContributions([bad])).toThrow(/32 bytes/)
  })

  it('refuses a pledge that does not fit its field', () => {
    expect(() => packCoFundContributions([contribution(1, [spend(1n, 0)], 2n ** 128n)])).toThrow(/exceeds/)
  })
})

describe('cofund shares', () => {
  const share = (index: number, fill: number) => ({index, signature: new Uint8Array(64).fill(fill)})

  it('round-trips index and signature', () => {
    const shares = [share(0, 7), share(3, 9)]
    expect(unpackCoFundShares(packCoFundShares(shares))).toEqual(shares)
  })

  it('reads an empty answer as no shares, not as a failure', () => {
    // A wallet that owns none of the offer's inputs answers "" — the caller has to tell that apart
    // from an error so a co-signer asked by mistake can be told which it is.
    expect(unpackCoFundShares('')).toEqual([])
  })

  it('refuses a length that is not a whole number of records', () => {
    expect(() => unpackCoFundShares('00'.repeat(SHARE_RECORD_LEN + 1))).toThrow(/whole number/)
  })

  it('refuses a signature that is not 64 bytes', () => {
    expect(() => packCoFundShares([{index: 0, signature: new Uint8Array(32)}])).toThrow(/64 bytes/)
  })

  it('keeps a repeated index rather than tidying it away', () => {
    // Both a duplicate and a gap are mistakes the native side names precisely. Sorting or
    // deduplicating here would hide which contributor answered twice.
    const shares = [share(1, 1), share(1, 2)]
    expect(unpackCoFundShares(packCoFundShares(shares))).toHaveLength(2)
  })

  it('preserves the order it was given, because the index is what binds', () => {
    const shares = [share(5, 1), share(2, 2)]
    expect(unpackCoFundShares(packCoFundShares(shares)).map((s) => s.index)).toEqual([5, 2])
  })
})

describe('the two sides of the wire agree', () => {
  // ⚠️ Read out of the Rust rather than trusted to a comment. Both files say "must equal the other",
  // and nothing enforced it — a width changed on one side would be read as a different record shape
  // on the other, at a boundary no host test crosses.
  const rust = readFileSync(join(__dirname, '../rust/src/cofunded.rs'), 'utf8')
  const constantIn = (name: string): number => {
    const found = rust.match(new RegExp(`pub const ${name}: usize = (\\d+);`))
    if (found?.[1] === undefined) throw new Error(`${name} is not declared in rust/src/cofunded.rs`)
    return Number(found[1])
  }

  it('on the contribution header width', () => {
    expect(CONTRIBUTION_HEADER_LEN).toBe(constantIn('CONTRIBUTION_HEADER_LEN'))
  })

  it('on the share record width', () => {
    expect(SHARE_RECORD_LEN).toBe(constantIn('SHARE_RECORD_LEN'))
  })
})
