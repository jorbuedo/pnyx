import {describe, expect, it} from 'vitest'
import {ETHEREUM_MAINNET_USDC_TOKEN, normalizeTransferRequestCrypto} from './transfer-normalization.js'

describe('normalizeTransferRequestCrypto', () => {
  it('normalizes Encryptus CARDANO/ADA to a Cardano mainnet native transfer', () => {
    const result = normalizeTransferRequestCrypto({
      client: 'encryptus',
      chain: 'CARDANO',
      name: 'ADA',
      address: 'addr1abc',
      amount: '5050000',
      token: 'unexpected-token',
    })

    expect(result).toEqual({
      client: 'encryptus',
      chain: 'cardano:mainnet',
      name: 'ADA',
      address: 'addr1abc',
      amount: '5050000',
      asset: 'ADA',
    })
  })

  it('normalizes Encryptus ETHEREUM/USDC to an Ethereum mainnet USDC transfer', () => {
    const result = normalizeTransferRequestCrypto({
      client: 'encryptus',
      chain: 'ETHEREUM',
      name: 'USDC',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      amount: '5050000',
    })

    expect(result).toEqual({
      client: 'encryptus',
      chain: 'eip155:1',
      name: 'USDC',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      amount: '5050000',
      asset: 'USDC',
      token: ETHEREUM_MAINNET_USDC_TOKEN,
    })
  })

  it('normalizes Encryptus ETH native labels without changing base-unit amounts', () => {
    const result = normalizeTransferRequestCrypto({
      client: 'encryptus',
      chain: 'ETH',
      name: 'ETH',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      amount: '50000000000000000',
      token: 'unexpected-token',
    })

    expect(result).toEqual({
      client: 'encryptus',
      chain: 'eip155:1',
      name: 'ETH',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      amount: '50000000000000000',
      asset: 'ETH',
    })
  })

  it('leaves unsupported clients unchanged', () => {
    const params = {
      client: 'another-client',
      chain: 'ETHEREUM',
      name: 'USDC',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      amount: '1000000',
    } as const

    expect(normalizeTransferRequestCrypto(params)).toBe(params)
  })
})
