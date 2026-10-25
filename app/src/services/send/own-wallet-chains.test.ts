import {CARDANO_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {describe, expect, it} from 'vitest'
import {isSeedBacked, ownWalletChains} from './own-wallet-chains'

describe('ownWalletChains', () => {
  it('offers both chains for a seed-backed wallet', () => {
    expect(ownWalletChains({primaryWallet: {}})).toEqual([CARDANO_MAINNET, MIDNIGHT_MAINNET])
  })

  /**
   * The three wallets that never derived a Midnight address. Offering one would put an address in the
   * picker that cannot be produced — the failure would land on whoever tapped it.
   */
  it('offers Cardano only for a hardware wallet', () => {
    expect(ownWalletChains({primaryWallet: {isHardware: true}})).toEqual([CARDANO_MAINNET])
  })

  it('offers Cardano only for a read-only wallet', () => {
    expect(ownWalletChains({primaryWallet: {implementation: 'readOnly'}})).toEqual([CARDANO_MAINNET])
  })

  it('offers Cardano only for a multisig wallet', () => {
    expect(ownWalletChains({primaryWallet: {source: 'multisig'}})).toEqual([CARDANO_MAINNET])
  })

  it('offers Cardano only when there is no primary wallet to judge', () => {
    expect(ownWalletChains({})).toEqual([CARDANO_MAINNET])
    expect(isSeedBacked({})).toBe(false)
  })
})
