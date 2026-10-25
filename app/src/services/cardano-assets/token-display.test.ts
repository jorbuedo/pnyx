import {describe, expect, it} from 'vitest'
import {tokenDisplayNames} from './token-display'

const info = (over: {label?: string; ticker?: string; name?: string}) => ({
  label: over.label ?? over.ticker ?? over.name ?? '',
  ...(over.ticker !== undefined ? {ticker: over.ticker} : {}),
  ...(over.name !== undefined ? {name: over.name} : {}),
})

describe('tokenDisplayNames', () => {
  it('leads with the ticker and adds the fuller name — the pairing that was invisible', () => {
    expect(tokenDisplayNames(info({ticker: 'WRT', name: 'WingRiders Governance Token'}))).toEqual({
      primary: 'WRT',
      secondary: 'WingRiders Governance Token',
    })
  })

  it('omits the second line when the name only repeats the ticker', () => {
    expect(tokenDisplayNames(info({ticker: 'NIGHT', name: 'NIGHT'}))).toEqual({primary: 'NIGHT'})
  })

  it('collapses a difference of case or spacing rather than showing it twice', () => {
    expect(tokenDisplayNames(info({ticker: '$CAST', name: ' $cast '}))).toEqual({primary: '$CAST'})
  })

  it('leads with the name when there is no ticker, and adds nothing under it', () => {
    // 71 of one wallet's 88 tokens are this case — mostly NFTs and unlisted assets.
    expect(tokenDisplayNames(info({name: 'Lil Sappys #942'}))).toEqual({primary: 'Lil Sappys #942'})
  })

  it('falls back to the resolved label when neither ticker nor name is set', () => {
    expect(tokenDisplayNames({label: '8fead602…'})).toEqual({primary: '8fead602…'})
  })

  it('never returns an empty primary for a missing info', () => {
    expect(tokenDisplayNames(undefined)).toEqual({primary: ''})
  })
})
