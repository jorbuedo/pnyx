// What an agent is told about a transaction. These pin the conclusions, not the shape of our IR — the
// whole point is that a caller never has to interpret `ownership.level` or a bigint to be right.
import type {ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {adaOf, describeTransaction, readableAssetName} from './describe-tx'

const io = (bech32: string | undefined, own: boolean, lovelace: bigint, assetId?: string) =>
  ({
    address: {hex: 'aabb', ...(bech32 === undefined ? {} : {bech32})},
    ownership: own ? {level: 'own', owner: 'funds'} : {level: 'none'},
    amounts: [{quantity: lovelace}, ...(assetId === undefined ? [] : [{assetId, quantity: 7n}])],
  }) as never

const tx = (over: Partial<ReviewedTransaction> = {}): ReviewedTransaction =>
  ({
    chain: 'cardano',
    fee: 173_465n,
    inputs: [],
    unresolvedInputs: [],
    outputs: [],
    referenceInputs: [],
    metadata: {},
    requiredSigners: [],
    scripts: {} as never,
    ownDelta: [],
    ownGroup: {} as never,
    identityGroup: {} as never,
    operations: [],
    warnings: [],
    ...over,
  }) as ReviewedTransaction

describe('adaOf', () => {
  it('keeps six decimals exactly, where a float would not', () => {
    expect(adaOf(10_454_176_372n)).toBe('10454.176372')
    expect(adaOf(1n)).toBe('0.000001')
    expect(adaOf(2_000_000n)).toBe('2')
    expect(adaOf(0n)).toBe('0')
  })

  it('signs an outflow, since the delta is the point', () => {
    expect(adaOf(-5_173_465n)).toBe('-5.173465')
  })
})

describe('readableAssetName', () => {
  // ⚠️ CIP-68 prefixes a four-byte label, so a well-formed name still begins with unprintable bytes.
  it('reads a CIP-68 name as text', () => {
    expect(readableAssetName('0014df104c494e4b')).toBe('LINK')
  })

  it('answers null rather than mojibake for bytes that are not text', () => {
    expect(readableAssetName('')).toBeNull()
    expect(readableAssetName('ff00')).toBeNull()
  })
})

describe('describeTransaction', () => {
  it('states the effect on this wallet with the fee already in it', () => {
    const out = describeTransaction(tx({ownDelta: [{quantity: -5_173_465n}]}))
    expect(out.thisWalletChangesBy.ada).toBe('-5.173465')
    expect(out.thisWalletChangesBy.lovelace).toBe('-5173465')
    expect(out.fee.ada).toBe('0.173465')
    expect(out.thisWalletChangesBy.note).toContain('fee is already included')
  })

  it('separates who is paid from what comes back', () => {
    const out = describeTransaction(
      tx({outputs: [io('addr_test1theirs', false, 5_000_000n), io('addr_test1ours', true, 100n)]}),
    )
    expect(out.paysOut.map((p) => p.address)).toEqual(['addr_test1theirs'])
    expect(out.returnsToThisWallet.map((p) => p.address)).toEqual(['addr_test1ours'])
  })

  // ⚠️ The whole point of `understood`. With inputs unread the delta is computed from a partial view
  // and is *wrong*, not merely imprecise — an agent reporting a confident figure from it is the same
  // failure as reading CBOR by eye.
  it('says plainly when the figures cannot be trusted', () => {
    const out = describeTransaction(
      tx({unresolvedInputs: [{txHashHex: 'ab', index: 0}] as never, ownDelta: [{quantity: -1n}]}),
    )
    expect(out.understood).toBe(false)
    expect(out.warningAboutThisAnswer).toContain('may be wrong')
    expect(out.warningAboutThisAnswer).toContain('cannot be determined')
    // The numbers are still given — they are what is known — but they are labelled.
    expect(out.thisWalletChangesBy.ada).toBe('-0.000001')
  })

  it('is silent about trust when everything resolved', () => {
    expect(describeTransaction(tx()).warningAboutThisAnswer).toBeUndefined()
  })

  // ⚠️ A tag like `stake-credential-reuse` names a real attack and tells an agent nothing.
  it('turns every warning into a sentence a person can be told', () => {
    const out = describeTransaction(tx({warnings: ['stake-credential-reuse', 'burning']}))
    expect(out.warnings[0]).toContain('cannot be spent by it')
    expect(out.warnings[1]).toContain('destroys tokens')
  })

  // A warning with no sentence must still arrive: one that disappears is worse than one nobody reads.
  it('names an unrecognised warning rather than dropping it', () => {
    const out = describeTransaction(tx({warnings: ['something-new' as never]}))
    expect(out.warnings[0]).toContain('something-new')
  })

  // ⚠️ The builders take bech32. An address that is only hex has to be flagged, or an agent hands it
  // straight back to `buildTransfer` and is told it is not an address.
  it('flags an address it could only give as hex', () => {
    const out = describeTransaction(tx({outputs: [io(undefined, false, 1n)]}))
    expect(out.paysOut[0]?.addressIsHexOnly).toBe(true)
  })

  it('omits metadata entirely when there is none, rather than an empty object', () => {
    expect(describeTransaction(tx())).not.toHaveProperty('metadata')
    expect(describeTransaction(tx({metadata: {674: {msg: ['hi']}}}))).toHaveProperty('metadata')
  })
})
