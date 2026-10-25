import type {UTxO} from '@evolution-sdk/evolution'
import {Address} from '@pnyx/cardano-core'
import type {CardanoUtxo} from '@pnyx/ur'
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {testUtxo} from '../cardano/test-utxo'
import {type CheckedInput, checkRequestUtxos, indexUtxosByOutpoint, resolveInputAddresses} from './verify-request-utxos'

const HASH_A = new Uint8Array(32).fill(0x11)
const HASH_B = new Uint8Array(32).fill(0x22)
// ⚠️ Real bech32. These were TRUNCATED addresses that never decoded — accepted by the old
// `address: string` and caught the moment Evolution's `UTxO` started validating one.
const ADDR =
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'
const OTHER_ADDR =
  'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w'

const keyPath = {
  components: [
    {index: 1852, hardened: true},
    {index: 1815, hardened: true},
    {index: 0, hardened: true},
    {index: 0, hardened: false},
    {index: 0, hardened: false},
  ],
}

const claimed = (over: Partial<CardanoUtxo> = {}): CardanoUtxo => ({
  transactionHash: HASH_A,
  index: 0,
  amount: '10000000',
  keyPath,
  address: ADDR,
  ...over,
})

const ours = (
  over: {
    readonly txHash?: string | number
    readonly index?: number
    readonly lovelace?: bigint
    readonly assets?: ReadonlyMap<string, bigint>
  } = {},
): UTxO.UTxO =>
  testUtxo({
    txHash: over.txHash ?? 0x11,
    index: over.index ?? 0,
    address: ADDR,
    lovelace: over.lovelace ?? 10_000_000n,
    ...(over.assets ? {assets: over.assets} : {}),
  })

describe('a claim that matches our synced state', () => {
  it('is verified', () => {
    const result = checkRequestUtxos([claimed()], indexUtxosByOutpoint([ours()]))
    expect(result.kind).toBe('reviewable')
    if (result.kind !== 'reviewable') return
    expect(result.inputs[0]?.trust).toEqual({kind: 'verified'})
    expect(result.unknownCount).toBe(0)
  })

  /**
   * Renders the values a verified input should show.
   *
   * ⚠️ This cannot distinguish reading our record from reading the request's: `verified` means the
   * two are byte-equal, so both produce this result. The source preference in the mapper is
   * defence against a later loosening of the comparison, and no test can pin it while the
   * comparison stays exact — stated here so nobody mistakes this for that guarantee.
   */
  it('renders the address and value of a verified input', () => {
    const result = checkRequestUtxos([claimed()], indexUtxosByOutpoint([ours()]))
    if (result.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(result.inputs[0]?.resolved.addressBech32).toBe(ADDR)
    expect(result.inputs[0]?.resolved.coin).toBe(10_000_000n)
  })

  it('carries our tokens through', () => {
    // ⚠️ The DOTTED spelling, which is what production emits. This fixture used the joined form
    // and that is what hid the `tokensOf` offset bug — see the note on that function.
    const withAssets = ours({assets: new Map([[`${'ab'.repeat(28)}.4d494c4b`, 42n]])})
    const result = checkRequestUtxos([claimed()], indexUtxosByOutpoint([withAssets]))
    if (result.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(result.inputs[0]?.resolved.tokens).toEqual([
      {policyIdHex: 'ab'.repeat(28), assetNameHex: '4d494c4b', amount: 42n},
    ])
  })
})

/**
 * The attack the module exists for: a body that spends a big UTxO while the request describes a
 * small one. Without the cross-check the review would show the small number and the user would
 * approve a much larger spend.
 */
describe('a claim that contradicts our synced state', () => {
  it('refuses an understated amount', () => {
    const result = checkRequestUtxos([claimed({amount: '1000000'})], indexUtxosByOutpoint([ours()]))
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toMatch(/claims amount 1000000, ours is 10000000/)
    expect(result.offending).toHaveLength(1)
  })

  it('refuses a substituted address', () => {
    const result = checkRequestUtxos([claimed({address: OTHER_ADDR})], indexUtxosByOutpoint([ours()]))
    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toMatch(/claims address/)
  })

  // One bad input poisons the request; a partially-honest batch is not partially signable.
  it('refuses the whole request when only one input is wrong', () => {
    const result = checkRequestUtxos(
      [claimed(), claimed({transactionHash: HASH_B, index: 1, amount: '5'})],
      indexUtxosByOutpoint([ours(), ours({txHash: 0x22, index: 1, lovelace: 7_000_000n})]),
    )
    expect(result.kind).toBe('refused')
  })

  // Lovelace can exceed 2^53, so comparison must not go through a float.
  it('detects a mismatch beyond the safe-integer range', () => {
    const big = 9_007_199_254_740_993n // 2^53 + 1
    const result = checkRequestUtxos(
      [claimed({amount: (big + 1n).toString()})],
      indexUtxosByOutpoint([ours({lovelace: big})]),
    )
    expect(result.kind).toBe('refused')
  })

  it('accepts a large amount that genuinely matches', () => {
    const big = 9_007_199_254_740_993n
    const result = checkRequestUtxos([claimed({amount: big.toString()})], indexUtxosByOutpoint([ours({lovelace: big})]))
    expect(result.kind).toBe('reviewable')
  })
})

describe('a UTxO we have never seen', () => {
  it('is unknown rather than refused — a co-signer input is legitimate', () => {
    const result = checkRequestUtxos([claimed({transactionHash: HASH_B})], indexUtxosByOutpoint([ours()]))
    expect(result.kind).toBe('reviewable')
    if (result.kind !== 'reviewable') return
    expect(result.inputs[0]?.trust).toEqual({kind: 'unknown'})
    expect(result.unknownCount).toBe(1)
  })

  // The screen needs this flag to avoid presenting an unverified number as established fact.
  it('is still marked unknown even though its claimed values are carried', () => {
    const result = checkRequestUtxos([claimed({transactionHash: HASH_B})], indexUtxosByOutpoint([]))
    if (result.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(result.inputs[0]?.resolved.coin).toBe(10_000_000n)
    expect(result.inputs[0]?.trust.kind).toBe('unknown')
  })

  it('distinguishes a different index on the same transaction', () => {
    const result = checkRequestUtxos([claimed({index: 7})], indexUtxosByOutpoint([ours()]))
    if (result.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(result.inputs[0]?.trust.kind).toBe('unknown')
  })
})

describe('shape', () => {
  it('keeps the request’s key path so the signer knows which key to use', () => {
    const result = checkRequestUtxos([claimed()], indexUtxosByOutpoint([ours()]))
    if (result.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(result.inputs[0]?.keyPathComponents).toHaveLength(5)
  })

  it('handles a request with no declared UTxOs', () => {
    const result = checkRequestUtxos([], indexUtxosByOutpoint([ours()]))
    expect(result).toEqual({kind: 'reviewable', inputs: [], unknownCount: 0})
  })
})

/**
 * `addressHex` is what the review classifies ownership by, and it used to be a hardcoded `''`.
 * That never threw: `Address.inspect('')` returns a base address with *empty credentials*, so
 * every input in an air-gap review — the wallet's own verified ones included — came out as not
 * ours. The type no longer lets `checkRequestUtxos` produce the field at all; this is the other
 * half, that the value it is completed with is the real one.
 */
describe('resolveInputAddresses', () => {
  // account 0, role 0, index 0 of `abandon … about` — the same key the wallet would derive.
  const REAL_ADDR =
    'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
  const PAYMENT_CRED = '0fdc780023d8be7c9ff3a6bdc0d8d3b263bd0cc12448c40948efbf42'

  const checkedInput = (addressBech32: string): CheckedInput => ({
    resolved: {txHashHex: 'aa'.repeat(32), index: 0, addressBech32, coin: 1n, tokens: []},
    trust: {kind: 'unknown'},
    keyPathComponents: keyPath.components,
  })

  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.either(effect))

  it('decodes to bytes whose credentials are the real ones', async () => {
    const result = await run(resolveInputAddresses([checkedInput(REAL_ADDR)]))
    if (Either.isLeft(result)) throw new Error(`expected success: ${String(result.left)}`)
    const [input] = result.right
    expect(input?.addressHex).not.toBe('')
    // The bug was silent because an empty hex still inspects — assert on what it inspects *to*.
    expect(Address.inspect(input?.addressHex ?? '').paymentCredHex).toBe(PAYMENT_CRED)
    expect(input?.addressBech32).toBe(REAL_ADDR)
  })

  // A per-input fallback would put an input on screen as nobody's coin, which is the class of lie
  // this module exists to prevent — so one bad address stops the batch.
  it('fails the whole batch rather than degrading one input', async () => {
    const result = await run(resolveInputAddresses([checkedInput(REAL_ADDR), checkedInput('not-an-address' as never)]))
    expect(Either.isLeft(result)).toBe(true)
  })

  it('resolves an empty batch to an empty list', async () => {
    const result = await run(resolveInputAddresses([]))
    expect(result).toStrictEqual(Either.right([]))
  })
})
