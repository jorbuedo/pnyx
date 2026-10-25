import {Cip67, Cip68} from '@evolution-sdk/cips'
import {AssetNameHex, PolicyIdHex} from '@evolution-sdk/review/Brands'
import {describe, expect, it} from 'vitest'
import {isCompanionAsset, programmableAssetRows} from './programmable-rows'
import type {ProgrammableRow} from './smart-wallet'

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const POLICY = '16b37cfebd14a0d3da5e8738333b21a145a9f6429f396199d22b67a5'
const TEST_NAME = '54455354'

const holding = (tokens: readonly {nameHex: string; amount: bigint}[]): ProgrammableRow => ({
  id: 'aa:0',
  lovelace: 5_000_000n,
  tokens: tokens.map((t) => ({
    policyIdHex: PolicyIdHex(POLICY),
    assetNameHex: AssetNameHex(t.nameHex),
    amount: t.amount,
  })),
})

describe('isCompanionAsset', () => {
  it('excludes a CIP-68 reference NFT', () => {
    const ref = bytesToHex(Cip68.referenceNftName(new Uint8Array([0x54, 0x45, 0x53, 0x54])))
    expect(isCompanionAsset(ref)).toBe(true)
  })

  it('keeps an unlabelled name, which is every live policy today', () => {
    expect(isCompanionAsset(TEST_NAME)).toBe(false)
  })

  it('keeps a user FT and a user NFT — those ARE the holding', () => {
    // Excluding by "has any label" would hide the token itself for any issuer who labels theirs.
    const content = new Uint8Array([0x54, 0x45, 0x53, 0x54])
    expect(isCompanionAsset(bytesToHex(Cip67.toAssetName(Cip67.LABEL_USER_FT, content)))).toBe(false)
    expect(isCompanionAsset(bytesToHex(Cip67.toAssetName(Cip67.LABEL_USER_NFT, content)))).toBe(false)
  })

  it('does not throw on a malformed name', () => {
    expect(isCompanionAsset('zz')).toBe(false)
    expect(isCompanionAsset('')).toBe(false)
  })
})

describe('programmableAssetRows', () => {
  it('sums an asset across several smart-wallet UTxOs', () => {
    const rows = programmableAssetRows([
      holding([{nameHex: TEST_NAME, amount: 600n}]),
      holding([{nameHex: TEST_NAME, amount: 400n}]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.quantity).toBe(1000n)
  })

  it('drops a co-resident reference NFT rather than showing it as a holding', () => {
    // ⚠️ CIP-113's no_escape keeps the reference NFT inside the holder's own smart wallet, unlike
    // everywhere else on Cardano. Without the filter the user sees a phantom unit of their own
    // token's metadata sitting beside the token.
    const ref = bytesToHex(Cip68.referenceNftName(new Uint8Array([0x54, 0x45, 0x53, 0x54])))
    const rows = programmableAssetRows([
      holding([
        {nameHex: TEST_NAME, amount: 1000n},
        {nameHex: ref, amount: 1n},
      ]),
    ])
    expect(rows.map((r) => r.label)).toEqual(['TEST'])
  })

  it('marks every row programmable, unpriced and of unstated scale', () => {
    const [row] = programmableAssetRows([holding([{nameHex: TEST_NAME, amount: 1n}])])
    expect(row).toMatchObject({isProgrammable: true, fiatValue: null, decimals: null, isAda: false})
  })
})
