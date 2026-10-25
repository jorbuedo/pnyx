import type {ReviewedIO, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {isNightClaim, NIGHT_ASSET_ID} from './night-redeem'

const TREASURY = '9015199b65dff1a5b9e281192c0157c23ccb579311232b94fe1c037c'
const ESCROW = '5986bfcc0cbfc60dec8df87715cc95d03817aac386b0e9d33da03b39'
/** A NIGHT liquidity pool — same token, unrelated contract. */
const DEX_SCRIPT = '06f3826bd76b498368b1f64a222946fc121000903b4d371d68852add'
const USER_KEY = '1e30ee0d2b84f31e99821f1e5e50c634c7f6ce23426228f80b96198a'

const NIGHT = (quantity: bigint) => ({assetId: NIGHT_ASSET_ID, quantity})
const ADA = (quantity: bigint) => ({quantity})

const io = (
  hashHex: string,
  type: 'key' | 'script',
  amounts: readonly {assetId?: string; quantity: bigint}[],
): ReviewedIO => ({
  address: {hex: `00${hashHex}`},
  ownership: {level: 'none'},
  amounts,
  credentials: {payment: {hashHex, type}},
})

const tx = (inputs: readonly ReviewedIO[], outputs: readonly ReviewedIO[]): ReviewedTransaction =>
  ({inputs, outputs}) as unknown as ReviewedTransaction

describe('isNightClaim', () => {
  it('recognises a first thaw — the treasury script spend', () => {
    const claim = tx(
      [io(TREASURY, 'script', [NIGHT(1_000n)]), io(USER_KEY, 'key', [ADA(5_000_000n)])],
      [io(TREASURY, 'script', [NIGHT(900n)]), io(USER_KEY, 'key', [NIGHT(100n)])],
    )
    expect(isNightClaim(claim)).toBe(true)
  })

  it('recognises a later thaw — the escrow script spend Yoroi cannot see', () => {
    // Yoroi matches one hardcoded treasury address, so every escrow thaw (one
    // per claimant, keyed by their own stake credential) slips past it.
    const claim = tx(
      [io(ESCROW, 'script', [NIGHT(900n)]), io(USER_KEY, 'key', [ADA(5_000_000n)])],
      [io(ESCROW, 'script', [NIGHT(800n)]), io(USER_KEY, 'key', [NIGHT(100n)])],
    )
    expect(isNightClaim(claim)).toBe(true)
  })

  it('does not claim an ordinary NIGHT transfer', () => {
    expect(isNightClaim(tx([io(USER_KEY, 'key', [NIGHT(100n)])], [io(USER_KEY, 'key', [NIGHT(100n)])]))).toBe(false)
  })

  it('does not claim a NIGHT trade against an unrelated contract', () => {
    // Mainnet has NIGHT pools behind other scripts; the token alone proves nothing.
    const swap = tx([io(DEX_SCRIPT, 'script', [NIGHT(5_000n)])], [io(USER_KEY, 'key', [NIGHT(5_000n)])])
    expect(isNightClaim(swap)).toBe(false)
  })

  it('does not claim an interaction with the contract that moves no NIGHT', () => {
    const noNight = tx([io(ESCROW, 'script', [ADA(2_000_000n)])], [io(USER_KEY, 'key', [ADA(1_800_000n)])])
    expect(isNightClaim(noNight)).toBe(false)
  })

  it('matches on the credential, not the address bytes', () => {
    // The escrow address is per-claimant (script hash + that holder's stake
    // credential), so two claimants share no address — only the credential.
    const otherHolder: ReviewedIO = {
      address: {hex: 'deadbeef'},
      ownership: {level: 'none'},
      amounts: [NIGHT(400n)],
      credentials: {payment: {hashHex: ESCROW, type: 'script'}, stake: {hashHex: 'ab'.repeat(28), type: 'key'}},
    }
    expect(isNightClaim(tx([otherHolder], [io(USER_KEY, 'key', [NIGHT(100n)])]))).toBe(true)
  })

  it('ignores a key credential that happens to equal a script hash', () => {
    const spoofed = tx([io(ESCROW, 'key', [NIGHT(900n)])], [io(USER_KEY, 'key', [NIGHT(100n)])])
    expect(isNightClaim(spoofed)).toBe(false)
  })
})
