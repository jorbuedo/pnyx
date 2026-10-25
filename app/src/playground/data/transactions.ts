/**
 * Fake transaction data for UI Playground.
 *
 * @module
 */

export type FakeTransaction = {
  id: string
  type: 'sent' | 'received' | 'swap' | 'stake' | 'governance' | 'nft'
  amount: string
  ticker: string
  date: string
  timestamp: number
  status: 'pending' | 'confirmed' | 'failed'
  address?: string
  fee?: string
  hash?: string
}

const now = Date.now()
const hour = 60 * 60 * 1000
const day = 24 * hour

export const fakeTransactions: FakeTransaction[] = [
  {
    id: 'tx1',
    type: 'sent',
    amount: '-150.00',
    ticker: 'ADA',
    date: '2 hours ago',
    timestamp: now - 2 * hour,
    status: 'confirmed',
    address: 'addr1qx2kd28nq8ac5prwg32hhvudlwggpgfp8utlyqxu6wqgz62f79qsd...',
    fee: '0.17',
    hash: 'abc123def456789...',
  },
  {
    id: 'tx2',
    type: 'received',
    amount: '+500.00',
    ticker: 'ADA',
    date: '1 day ago',
    timestamp: now - 1 * day,
    status: 'confirmed',
    address: 'addr1qx7890abc...',
  },
  {
    id: 'tx3',
    type: 'swap',
    amount: '1,000.00',
    ticker: 'ADA',
    date: '2 days ago',
    timestamp: now - 2 * day,
    status: 'confirmed',
  },
  {
    id: 'tx4',
    type: 'stake',
    amount: '5,000.00',
    ticker: 'ADA',
    date: '3 days ago',
    timestamp: now - 3 * day,
    status: 'confirmed',
  },
  {
    id: 'tx5',
    type: 'received',
    amount: '+25.50',
    ticker: 'ADA',
    date: '5 mins ago',
    timestamp: now - 5 * 60 * 1000,
    status: 'pending',
  },
  {
    id: 'tx6',
    type: 'governance',
    amount: '0.00',
    ticker: 'ADA',
    date: '1 week ago',
    timestamp: now - 7 * day,
    status: 'confirmed',
  },
  {
    id: 'tx7',
    type: 'sent',
    amount: '-10.00',
    ticker: 'ADA',
    date: '10 mins ago',
    timestamp: now - 10 * 60 * 1000,
    status: 'failed',
  },
]
