import {describe, expect, it} from 'vitest'
import {transactionInvolvesNft} from './transaction-involves-nft.js'
import type {TransactionData} from './unified-transaction.js'

const base = {
  hash: 'a',
  chain: 'eip155:1',
  status: 'confirmed',
  direction: 'sent',
  type: 'transfer',
  from: '0xfrom',
  value: 0n,
} as const satisfies Partial<TransactionData>

describe('transactionInvolvesNft', () => {
  it('detects populated nftTransfers', () => {
    expect(
      transactionInvolvesNft({
        ...base,
        nftTransfers: [{contractAddress: '0xnft', tokenId: '1', from: '0xfrom', to: '0xto'}],
      }),
    ).toBe(true)
  })

  it('detects indexed hasNft without nftTransfers', () => {
    expect(transactionInvolvesNft({...base, hasNft: true})).toBe(true)
  })

  it('detects classified nft type', () => {
    expect(transactionInvolvesNft({...base, type: 'nft'})).toBe(true)
  })

  it('detects metadata.nft hint', () => {
    expect(transactionInvolvesNft({...base, metadata: {nft: true}})).toBe(true)
  })

  it('returns false for plain transfers', () => {
    expect(transactionInvolvesNft(base)).toBe(false)
  })
})
