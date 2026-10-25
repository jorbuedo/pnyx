/**
 * Fake token data for UI Playground.
 *
 * @module
 */

export type FakeToken = {
  id: string
  name: string
  ticker: string
  decimals: number
  balance: string
  fiatValue?: string
  change24h?: number
  logoUri?: string
  policyId?: string
  fingerprint?: string
}

export const fakeTokens: FakeToken[] = [
  {
    id: 'ada',
    name: 'Cardano',
    ticker: 'ADA',
    decimals: 6,
    balance: '12,345.67',
    fiatValue: '$4,567.89',
    change24h: 2.34,
  },
  {
    id: 'hosky',
    name: 'Hosky Token',
    ticker: 'HOSKY',
    decimals: 0,
    balance: '1,000,000,000',
    fiatValue: '$0.01',
    change24h: -5.67,
    policyId: 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235',
    fingerprint: 'asset1h0p6ucmqpwqhqnhftxrwq9t9zmf4ny24p7szj6',
  },
  {
    id: 'sundae',
    name: 'SundaeSwap',
    ticker: 'SUNDAE',
    decimals: 6,
    balance: '5,432.10',
    fiatValue: '$123.45',
    change24h: 8.91,
  },
  {
    id: 'min',
    name: 'Minswap',
    ticker: 'MIN',
    decimals: 6,
    balance: '10,000.00',
    fiatValue: '$567.89',
    change24h: -1.23,
  },
  {
    id: 'wmtx',
    name: 'World Mobile',
    ticker: 'WMTX',
    decimals: 6,
    balance: '25,000.00',
    fiatValue: '$2,345.67',
    change24h: 4.56,
  },
]

// Export specific tokens for type safety
export const fakeAda = fakeTokens.find((t) => t.id === 'ada') as FakeToken
export const fakeMin = fakeTokens.find((t) => t.id === 'min') as FakeToken

export const fakeTokenPair = {
  from: fakeAda,
  to: fakeMin,
}
