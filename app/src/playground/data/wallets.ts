/**
 * Fake wallet data for UI Playground.
 *
 * @module
 */

import {BITCOIN_MAINNET, CARDANO_MAINNET, type ChainId, ETHEREUM_MAINNET} from '@pnyx/config'

export type FakeWallet = {
  id: string
  name: string
  chainId: ChainId
  balance: string
  fiatBalance: string
  accountIndex: number
  isHardware: boolean
  createdAt: number
}

export const fakeWallets: FakeWallet[] = [
  {
    id: 'wallet-1',
    name: 'Main Wallet',
    chainId: CARDANO_MAINNET,
    balance: '12,345.67 ADA',
    fiatBalance: '$4,567.89',
    accountIndex: 0,
    isHardware: false,
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
  },
  {
    id: 'wallet-2',
    name: 'Ledger Hardware',
    chainId: CARDANO_MAINNET,
    balance: '50,000.00 ADA',
    fiatBalance: '$18,500.00',
    accountIndex: 0,
    isHardware: true,
    createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
  },
  {
    id: 'wallet-3',
    name: 'DeFi Wallet',
    chainId: ETHEREUM_MAINNET,
    balance: '2.5 ETH',
    fiatBalance: '$4,750.00',
    accountIndex: 0,
    isHardware: false,
    createdAt: Date.now() - 15 * 24 * 60 * 60 * 1000, // 15 days ago
  },
  {
    id: 'wallet-4',
    name: 'Savings',
    chainId: BITCOIN_MAINNET,
    balance: '0.25 BTC',
    fiatBalance: '$10,750.00',
    accountIndex: 0,
    isHardware: true,
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
  },
]

export const fakeAccounts = [
  {index: 0, name: 'Account 0', balance: '10,000.00 ADA'},
  {index: 1, name: 'Account 1', balance: '2,000.00 ADA'},
  {index: 2, name: 'Account 2', balance: '345.67 ADA'},
]
