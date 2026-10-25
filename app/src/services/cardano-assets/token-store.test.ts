import {describe, expect, it} from 'vitest'
import type {TokenInfo} from './token-metadata'
import {parseTokenInfoRow, persistableInfos} from './token-store'

const known = (id: string): TokenInfo => ({
  id,
  decimals: 6,
  ticker: 'X',
  label: 'X',
  isNft: false,
  known: true,
  hasIcon: true,
})
const unknown = (id: string): TokenInfo => ({
  id,
  decimals: 0,
  symbol: 'x',
  label: 'x',
  isNft: false,
  known: false,
  hasIcon: false,
})

describe('parseTokenInfoRow', () => {
  it('round-trips a serialized known info', () => {
    const info = known('0691b2fe.4e49474854')
    expect(parseTokenInfoRow(JSON.stringify(info))).toEqual(info)
  })
  it('returns null for a corrupt / non-conforming blob (treated as a cache miss)', () => {
    expect(parseTokenInfoRow('not json')).toBeNull()
    expect(parseTokenInfoRow('{}')).toBeNull()
    expect(parseTokenInfoRow(JSON.stringify({id: 'x'}))).toBeNull() // missing decimals/label
  })
})

describe('persistableInfos', () => {
  it('keeps only registry-resolved (known) infos with a real id — never the synthetic fallback', () => {
    const infos = [known('a.1'), unknown('b.2'), known(''), known('c.3')]
    expect(persistableInfos(infos).map((i) => i.id)).toEqual(['a.1', 'c.3'])
  })
})
