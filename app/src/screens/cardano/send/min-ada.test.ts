import {AddressHex} from '@evolution-sdk/review/Brands'
import {describe, expect, it} from 'vitest'
import {minAdaForOutput} from './min-ada'

// Mainnet `coinsPerUtxoByte`.
const PER_BYTE = 4310n
const ADA_ID = ''
const ADDR = AddressHex(`01${'aa'.repeat(28)}${'bb'.repeat(28)}`)
const POLICY = 'ab'.repeat(28)

/**
 * ⚠️ No codec, and nothing is stubbed. This used to build a `MinAdaCodec` from the real adapter in
 * a `beforeAll` — so the test was already measuring the real rule, but through an injection point
 * that existed only because the measurement needed one. It does not, so the test calls what the
 * wallet calls.
 */
const floor = (amounts: [string, bigint][], address = ADDR) => minAdaForOutput(PER_BYTE, address, new Map(amounts))

describe('minAdaForOutput', () => {
  it('grows with what the output holds — which a single constant cannot express', () => {
    const adaOnly = floor([[ADA_ID, 2_000_000n]])
    const oneToken = floor([
      [ADA_ID, 2_000_000n],
      [`${POLICY}.4e49474854`, 100n],
    ])
    const manyTokens = floor([
      [ADA_ID, 2_000_000n],
      ...Array.from({length: 20}, (_, i) => [`${POLICY}.${(i + 16).toString(16).repeat(10)}`, 1n] as [string, bigint]),
    ])

    expect(adaOnly).not.toBeNull()
    expect(oneToken as bigint).toBeGreaterThan(adaOnly as bigint)
    expect(manyTokens as bigint).toBeGreaterThan(oneToken as bigint)
  })

  it('exceeds the flat 1 ADA floor this replaced, even for a single small token', () => {
    // The old constant was described as conservative; it was optimistic. A user
    // attaching exactly 1 ADA to one token passed validation and failed at build.
    const oneToken = floor([
      [ADA_ID, 2_000_000n],
      [`${POLICY}.4e49474854`, 100n],
    ])
    expect(oneToken as bigint).toBeGreaterThan(1_000_000n)
  })

  it('charges more for a longer asset name — the name is part of the output', () => {
    const short = floor([
      [ADA_ID, 2_000_000n],
      [`${POLICY}.4e49474854`, 1n],
    ])
    const long = floor([
      [ADA_ID, 2_000_000n],
      [`${POLICY}.${'cd'.repeat(32)}`, 1n],
    ])
    expect(long as bigint).toBeGreaterThan(short as bigint)
  })

  it('does not depend on the ADA already typed in — the floor is a property of the output', () => {
    const assets: [string, bigint][] = [[`${POLICY}.4e49474854`, 1n]]
    expect(floor([[ADA_ID, 1n], ...assets])).toBe(floor([[ADA_ID, 900_000_000n], ...assets]))
  })

  it('is null — not zero — when the output cannot be encoded', () => {
    // `null` means "unknown floor"; a caller treating it as 0 would wave through
    // an output the ledger rejects.
    // Cast, not constructed: the brand would refuse this now, and what is under test is that
    // `floor` returns null for an address it cannot read — a value reaching it from an untyped
    // source is exactly the case worth keeping.
    // ⚠️ Still reachable without a codec: `Address.fromHex` throws on it and the `catch` logs and
    // returns null, which is the contract. A test asserting this against a stub would have
    // asserted the stub.
    expect(floor([[ADA_ID, 2_000_000n]], 'not-hex' as AddressHex)).toBeNull()
  })
})
