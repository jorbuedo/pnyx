import {describe, expect, it} from 'vitest'
import {
  aggregatePortfolioFiat,
  filterPortfolioAssets,
  isNftAsset,
  type PortfolioAsset,
  sortPortfolioAssets,
} from './portfolio'

const asset = (over: Partial<PortfolioAsset> & {label: string}): PortfolioAsset => ({
  id: over.id ?? over.label,
  isAda: false,
  isNft: false,
  decimals: 0,
  quantity: 1n,
  fiatValue: null,
  ...over,
})

const ada = asset({id: '', label: 'ADA', isAda: true, fiatValue: 5})

describe('sortPortfolioAssets', () => {
  it('orders ADA → priced (value desc) → unpriced (alpha)', () => {
    const zebra = asset({label: 'Zebra', fiatValue: 100})
    const alpha = asset({label: 'Alpha', fiatValue: 100})
    const mid = asset({label: 'Mid', fiatValue: 250})
    const plainZ = asset({label: 'Zeta'})
    const plainA = asset({label: 'Beta'})

    const sorted = sortPortfolioAssets([plainZ, zebra, ada, mid, plainA, alpha])
    expect(sorted.map((a) => a.label)).toEqual([
      'ADA', // always first
      'Mid', // priced 250
      'Alpha', // priced 100, alpha tiebreak before Zebra
      'Zebra', // priced 100
      'Beta', // unpriced, alpha
      'Zeta', // unpriced, alpha
    ])
  })

  it('does not mutate the input', () => {
    const input = [asset({label: 'B', fiatValue: 1}), ada]
    const before = input.map((a) => a.label)
    sortPortfolioAssets(input)
    expect(input.map((a) => a.label)).toEqual(before)
  })
})

describe('aggregatePortfolioFiat', () => {
  it('sums every priced asset (including ADA), ignoring unpriced', () => {
    const assets = [ada, asset({label: 'X', fiatValue: 10}), asset({label: 'Y'}), asset({label: 'Z', fiatValue: 2.5})]
    expect(aggregatePortfolioFiat(assets)).toBe(17.5) // 5 + 10 + 2.5
  })

  it('is null when nothing is priced', () => {
    expect(aggregatePortfolioFiat([asset({label: 'X'}), asset({label: 'Y'})])).toBeNull()
  })
})

describe('isNftAsset with an unknown scale', () => {
  it('treats a single unit of an undocumented token as an NFT', () => {
    // From the outside that is indistinguishable from an NFT, and it keeps such an
    // asset out of the fungible views rather than in both.
    const one = asset({id: 'p.unknown', label: 'Mystery', quantity: 1n, decimals: null})
    expect(isNftAsset(one, new Set())).toBe(true)
  })

  it('does not treat a large holding of an undocumented token as an NFT', () => {
    const many = asset({id: 'p.unknown', label: 'Mystery', quantity: 5_000n, decimals: null})
    expect(isNftAsset(many, new Set())).toBe(false)
  })
})

describe('filterPortfolioAssets', () => {
  const snek = asset({id: 'p.snek', label: 'SNEK', fiatValue: 3, quantity: 100n}) // verified fungible
  const spam = asset({id: 'p.spam', label: 'FreeAirdrop.io', quantity: 1_000_000n}) // unverified fungible
  const nft = asset({id: 'p.nft', label: 'CoolNFT #1', quantity: 1n, decimals: 0}) // single unit → NFT
  const verified = new Set(['p.snek'])
  const base = {verifiedIds: verified, showUnverified: false, type: 'all' as const, query: ''}
  const all = [ada, snek, spam, nft]
  const labels = (r: PortfolioAsset[]) => r.map((a) => a.label)

  it('hides everything unverified by default (incl. NFTs), keeps ADA + verified fungibles', () => {
    expect(labels(filterPortfolioAssets(all, base))).toEqual(['ADA', 'SNEK'])
  })

  it('reveals unverified fungibles + NFTs when showUnverified is on', () => {
    const out = labels(filterPortfolioAssets(all, {...base, showUnverified: true}))
    expect(out).toContain('FreeAirdrop.io')
    expect(out).toContain('CoolNFT #1')
  })

  it('type=tokens excludes NFTs; type=nfts shows NFTs bypassing the verified gate', () => {
    expect(labels(filterPortfolioAssets(all, {...base, type: 'tokens'}))).toEqual(['ADA', 'SNEK'])
    // NFT surfaces under the NFTs tab even though verified-only is still on.
    expect(labels(filterPortfolioAssets(all, {...base, type: 'nfts'}))).toEqual(['CoolNFT #1'])
  })

  it('search matches label or id', () => {
    expect(labels(filterPortfolioAssets(all, {...base, query: 'snek'}))).toEqual(['SNEK'])
    expect(labels(filterPortfolioAssets(all, {...base, type: 'nfts', query: 'cool'}))).toEqual(['CoolNFT #1'])
  })
})
