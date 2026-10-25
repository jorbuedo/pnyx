/**
 * Fake address data for UI Playground.
 *
 * @module
 */

export type FakeAddress = {
  address: string
  chainId: string
  label?: string
}

export const fakeAddresses = {
  cardano: {
    mainnet: 'addr1qx2kd28nq8ac5prwg32hhvudlwggpgfp8utlyqxu6wqgz62f79qsdmm5dsknt9ecr5w468r9ey0fxwkdrwh08ly3tu9sy0f4qd',
    testnet:
      'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
  },
  ethereum: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE9e',
  bitcoin: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  solana: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
}

export const fakeAddressList: FakeAddress[] = [
  {address: fakeAddresses.cardano.mainnet, chainId: 'cardano', label: 'Main Wallet'},
  {address: fakeAddresses.ethereum, chainId: 'ethereum', label: 'ETH Wallet'},
  {address: fakeAddresses.bitcoin, chainId: 'bitcoin', label: 'BTC Savings'},
  {address: fakeAddresses.solana, chainId: 'solana', label: 'SOL DeFi'},
]
