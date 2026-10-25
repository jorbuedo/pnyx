import {encodeShieldedAddress} from '@pnyx/wallet'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {createMidnightHandlerContext, shieldedAddressParts} from './dapp-context'

const CPK = new Uint8Array(32).fill(0xab)
const EPK = new Uint8Array(32).fill(0xcd)

describe('shieldedAddressParts', () => {
  it('matches the reference implementation byte for byte', () => {
    // Captured from `@midnight-ntwrk/wallet-sdk-address-format` for the same keys before that package
    // was ruled out for the app (it pulls ledger-v8, which cannot bundle for React Native). Pinning its
    // output keeps this port honest without importing it.
    const parts = shieldedAddressParts(encodeShieldedAddress(CPK, EPK, 'preprod'))

    expect(parts.shieldedCoinPublicKey).toBe(
      'mn_shield-cpk_preprod14w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4st02clq',
    )
    expect(parts.shieldedEncryptionPublicKey).toBe(
      'mn_shield-epk_preprod1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxsleel40',
    )
  })

  it('passes the address through unchanged', () => {
    const address = encodeShieldedAddress(CPK, EPK, 'preprod')

    expect(shieldedAddressParts(address).shieldedAddress).toBe(address)
  })

  it('splits the payload at 32 bytes rather than swapping the halves', () => {
    const parts = shieldedAddressParts(encodeShieldedAddress(CPK, EPK, 'preprod'))
    const swapped = shieldedAddressParts(encodeShieldedAddress(EPK, CPK, 'preprod'))

    // Swapping the inputs swaps which key lands in which half.
    expect(swapped.shieldedCoinPublicKey).toBe(
      'mn_shield-cpk_preprod1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxs97gkfs',
    )
    expect(parts.shieldedEncryptionPublicKey).toBe(
      'mn_shield-epk_preprod1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxsleel40',
    )
    // Same payload, different HRP — so the checksums differ. Which is why a half cannot be turned into
    // the other by editing the string, and why these are pinned rather than derived from each other.
    expect(swapped.shieldedCoinPublicKey).not.toBe(parts.shieldedEncryptionPublicKey)
  })

  it('carries the network the address declares, not an assumed one', () => {
    // A wallet holds addresses for several networks; a fixed one would re-encode under the wrong segment.
    expect(shieldedAddressParts(encodeShieldedAddress(CPK, EPK, 'undeployed')).shieldedCoinPublicKey).toContain(
      'undeployed',
    )
    // mainnet carries no network segment at all, which the encoder handles and the checksum reflects.
    expect(shieldedAddressParts(encodeShieldedAddress(CPK, EPK, 'mainnet')).shieldedCoinPublicKey).toBe(
      'mn_shield-cpk14w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4s9yzwdn',
    )
  })

  it('refuses an address of the wrong kind rather than splitting it anyway', () => {
    // A night address is 32 bytes; splitting it at 32 would yield an empty encryption key that encodes.
    expect(() =>
      shieldedAddressParts('mn_addr_preprod1g84s5k7cxzw5fvxq3hgx4tjnse8nnp8s5wctep275catzsunah8q9e3aqx'),
    ).toThrow(/shielded/)
  })

  it('refuses something that is not a Midnight address', () => {
    expect(() => shieldedAddressParts('not-bech32m-at-all')).toThrow(/readable Midnight address/)
    expect(() => shieldedAddressParts('mn_shield-addr_preprod1damaged')).toThrow()
  })
})

const PREPROD = 'mn_addr_preprod1dwv2rta0a2skyhrvukaw2q9r2sq6yc4jhj63rf7afxpkrrv6g35q49ekgd'
const PREVIEW = 'mn_addr_preview1dwv2rta0a2skyhrvukaw2q9r2sq6yc4jhj63rf7afxpkrrv6g35q4y8xms'
const NIGHT = '0'.repeat(64)

/**
 * A context whose unshielded cache belongs to `cacheAddress`, serving a wallet whose current address is
 * `walletAddress`. The two differ exactly when the app has switched network without reopening the
 * wallet — the case this fixture exists for.
 */
const contextOver = (walletAddress: string, cacheAddress: string) => {
  const asked: string[] = []
  const context = createMidnightHandlerContext({
    receiveAddress: async () => walletAddress,
    unshieldedTotals: async (address) => {
      asked.push(address)
      return address === cacheAddress ? new Map([[NIGHT, 2_000_000_000n]]) : null
    },
    shieldedTotals: async () => null,
    activity: async (address) => {
      asked.push(address)
      return []
    },
    rewardAddresses: async () => [],
    spendableDust: async () => null,
    network: 'preprod',
    checkPreimage: async () => [],
    proveCircuit: async () => new Uint8Array(),
  })
  return {context, asked}
}

describe('unshielded balances are read for the wallet’s own network', () => {
  it('answers with the totals when the cache belongs to this address', async () => {
    const {context, asked} = contextOver(PREPROD, PREPROD)
    await expect(Effect.runPromise(context.unshieldedBalances)).resolves.toEqual({[NIGHT]: 2_000_000_000n})
    expect(asked).toEqual([PREPROD])
  })

  // The defect this pins, seen on a device 2026-08-28: the cache is one blob per wallet+account with no
  // network in its key, so after a switch a wallet nobody reopened still held preview UTxOs — and the
  // agent was told it holds 2,000 NIGHT on preprod, where it held none. Answering `{}` would be the
  // other half of the same lie: nobody has looked here, which is not the same as holding nothing.
  it('refuses rather than reporting another network’s balance', async () => {
    const {context, asked} = contextOver(PREPROD, PREVIEW)
    await expect(Effect.runPromise(context.unshieldedBalances)).rejects.toThrow(/no synced unshielded state/)
    expect(asked).toEqual([PREPROD])
  })

  it('asks for history by the same address, so a stale cache cannot answer it either', async () => {
    const {context, asked} = contextOver(PREPROD, PREVIEW)
    await expect(Effect.runPromise(context.txHistory(1, 10))).resolves.toEqual([])
    expect(asked).toEqual([PREPROD])
  })
})
