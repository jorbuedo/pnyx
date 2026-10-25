import {MIDNIGHT_MAINNET} from '@pnyx/config'
import {describe, expect, it} from 'vitest'

import {filterPortfolioAssets, sortPortfolioAssets} from '../../cardano-assets/portfolio'
import {midnightPortfolioAssets} from './midnight-portfolio'
import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

const LABELS = {unshielded: 'Unshielded', shielded: 'Shielded'}
const OTHER = 'ff00000000000000000000000000000000000000000000000000000000000000'
const colour = (hex: string): Uint8Array => Uint8Array.from((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)))

describe('midnightPortfolioAssets', () => {
  it('builds an unshielded NIGHT row', () => {
    const [asset] = midnightPortfolioAssets({
      unshieldedTotals: new Map([[NIGHT_TOKEN_TYPE, 6_000_000_000n]]),
      shieldedBalances: null,
      labels: LABELS,
    })
    expect(asset).toEqual({
      id: `midnight:${NIGHT_TOKEN_TYPE}`,
      chainId: MIDNIGHT_MAINNET,
      isAda: false,
      isChainNative: true,
      isNft: false,
      label: 'NIGHT',
      subtitle: 'Unshielded',
      decimals: 6,
      quantity: 6_000_000_000n,
      fiatValue: null,
    })
  })

  it('keeps the two rails as separate rows, since they are not interchangeable', () => {
    const assets = midnightPortfolioAssets({
      unshieldedTotals: new Map([[NIGHT_TOKEN_TYPE, 10n]]),
      shieldedBalances: [{color: colour(NIGHT_TOKEN_TYPE), value: 5n}],
      labels: LABELS,
    })
    expect(assets.map((a) => a.subtitle)).toEqual(['Unshielded', 'Shielded'])
    expect(assets.map((a) => a.quantity)).toEqual([10n, 5n])
    expect(new Set(assets.map((a) => a.id)).size).toBe(2)
  })

  it('reads an unread rail as no rows, never as a zero holding', () => {
    expect(midnightPortfolioAssets({unshieldedTotals: null, shieldedBalances: null, labels: LABELS})).toEqual([])
  })

  it('omits a zero balance', () => {
    expect(
      midnightPortfolioAssets({
        unshieldedTotals: new Map([[NIGHT_TOKEN_TYPE, 0n]]),
        shieldedBalances: [{color: colour(NIGHT_TOKEN_TYPE), value: 0n}],
        labels: LABELS,
      }),
    ).toEqual([])
  })

  it('never states a fiat value, because no price source exists', () => {
    const assets = midnightPortfolioAssets({
      unshieldedTotals: new Map([[NIGHT_TOKEN_TYPE, 1n]]),
      shieldedBalances: null,
      labels: LABELS,
    })
    // 0 would sum into the portfolio total and understate it; null is absent.
    expect(assets.every((a) => a.fiatValue === null)).toBe(true)
  })

  it('labels an unknown token by a short head of its type, with unknown decimals', () => {
    const [asset] = midnightPortfolioAssets({
      unshieldedTotals: new Map([[OTHER, 7n]]),
      shieldedBalances: null,
      labels: LABELS,
    })
    expect(asset?.label).toBe('ff000000…')
    // No metadata source stated a scale, so it stays unknown rather than defaulting to 6.
    expect(asset?.decimals).toBeNull()
    expect(asset?.isChainNative).toBe(false)
  })
})

describe('Midnight rows in the shared asset list', () => {
  const midnight = midnightPortfolioAssets({
    unshieldedTotals: new Map([[NIGHT_TOKEN_TYPE, 6_000_000_000n]]),
    shieldedBalances: null,
    labels: LABELS,
  })

  it('survives the verified filter, which has no registry to check them against', () => {
    // Applying the gate would hide every Midnight holding: no such list exists, so every id is
    // "unverified".
    const kept = filterPortfolioAssets(midnight, {
      verifiedIds: new Set<string>(),
      showUnverified: false,
      type: 'all',
      query: '',
    })
    expect(kept).toHaveLength(1)
  })

  it('ranks with the base asset rather than falling to the unpriced tail', () => {
    const pricedCardanoToken = {
      id: 'aa.bb',
      isAda: false,
      isNft: false,
      label: 'SOMETHING',
      decimals: 6,
      quantity: 1n,
      fiatValue: 1234,
    }
    const sorted = sortPortfolioAssets([pricedCardanoToken, ...midnight])
    expect(sorted[0]?.label).toBe('NIGHT')
  })
})
