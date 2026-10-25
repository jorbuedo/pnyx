import {describe, expect, it} from 'vitest'
import {amountUnitFor} from './token-metadata'

describe('amountUnitFor', () => {
  const base = {decimals: 0, isNft: false, known: false, hasIcon: false} as const

  it('uses the ticker when there is one', () => {
    expect(amountUnitFor({...base, id: `${'ab'.repeat(28)}.4e49474854`, label: 'x', ticker: 'NIGHT'})).toBe('NIGHT')
  })

  it('falls back to a registry name', () => {
    expect(amountUnitFor({...base, id: `${'ab'.repeat(28)}.00`, label: 'x', name: 'Some Token'})).toBe('Some Token')
  })

  it('uses a decoded on-chain asset name', () => {
    // "NIGHT" as hex — a real name the minter chose, so it units an amount.
    expect(amountUnitFor({...base, id: `${'ab'.repeat(28)}.4e49474854`, label: 'NIGHT'})).toBe('NIGHT')
  })

  it('is undefined when the label is only a fingerprint', () => {
    // The row already shows the fingerprint on the left; repeating it after the quantity
    // renders "1 asset1cxcws8…vhl3g35s" and buries the number in the identifier.
    expect(amountUnitFor({...base, id: `${'ab'.repeat(28)}.`, label: 'asset1cxcws8…vhl3g35s'})).toBeUndefined()
  })

  it('ignores an empty ticker or name rather than printing nothing as a unit', () => {
    expect(amountUnitFor({...base, id: `${'ab'.repeat(28)}.`, label: 'asset1…', ticker: '', name: ''})).toBeUndefined()
  })
})
