/**
 * Wallet-shaped view fixtures for the UI Playground.
 *
 * `WalletGroupView` and `ChainWallet` are the provider-level shapes several
 * wallet components take directly, so they get one fixture here rather than a
 * hand-rolled object literal per showcase.
 *
 * @module
 */

import {CARDANO_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import type {ChainWallet, WalletGroupId, WalletProfile} from '@pnyx/wallet'
import type {WalletGroupView} from '../../providers'

/** Stable so identicons and plate text do not change between reloads. */
const GROUP_ID = 'playground-group-0' as WalletGroupId

const profile: WalletProfile = {iconStyle: 'jazzicon'}

const cardanoWallet: ChainWallet = {
  groupId: GROUP_ID,
  chainId: CARDANO_MAINNET,
  name: 'Playground Wallet',
  implementation: 'cip1852',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  checksum: {plate: 'PNYX-4213', seed: '9f2c7a1be4d05386'},
  profile,
  accounts: [
    {index: 0, enabled: true},
    {index: 1, enabled: false},
  ],
  selectedAccountIndex: 0,
  source: 'mnemonic',
}

const midnightWallet: ChainWallet = {
  ...cardanoWallet,
  chainId: MIDNIGHT_MAINNET,
  implementation: 'bip44',
}

/** A two-chain software wallet group. */
export const fakeWalletGroupView: WalletGroupView = {
  groupId: GROUP_ID,
  name: 'Playground Wallet',
  chains: [CARDANO_MAINNET, MIDNIGHT_MAINNET],
  primaryWallet: cardanoWallet,
  wallets: [cardanoWallet, midnightWallet],
  profile,
}

/** A read-only group, to show the status-label branch. */
export const fakeWatchOnlyGroupView: WalletGroupView = {
  ...fakeWalletGroupView,
  groupId: 'playground-group-1' as WalletGroupId,
  name: 'Watch-only Wallet',
  chains: [CARDANO_MAINNET],
  primaryWallet: {...cardanoWallet, implementation: 'readOnly', source: 'read-only'},
  wallets: [{...cardanoWallet, implementation: 'readOnly', source: 'read-only'}],
}
