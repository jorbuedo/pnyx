import {CARDANO_MAINNET} from '@pnyx/config'
import {describe, expect, it} from 'vitest'
import {cardanoChainIdFor} from './chain-id'

describe('cardanoChainIdFor', () => {
  it('maps every Cardano network to the single defined Cardano ChainId', () => {
    expect(cardanoChainIdFor('mainnet')).toBe(CARDANO_MAINNET)
    expect(cardanoChainIdFor('preprod')).toBe(CARDANO_MAINNET)
    expect(cardanoChainIdFor('preview')).toBe(CARDANO_MAINNET)
  })
})
