/**
 * Pure portfolio ordering + aggregation, shared by the Wallets-home widget and
 * the Cardano portfolio screen so both rank and total identically.
 *
 * Order: ADA first; then priced tokens by fiat value (desc); then unpriced
 * tokens alphabetically by label. (No icon tier — with the cexplorer icon
 * fallback nearly every token resolves an icon, so it wouldn't discriminate.)
 * The total balance is the sum of every priced asset's value — unpriced assets
 * contribute nothing (they're absent, not zeroed).
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'

export type PortfolioAsset = {
  /** App asset id (`"policyHex.assetNameHex"`); `''` for ADA. */
  readonly id: string
  /**
   * Which chain the holding is on. **Absent means Cardano** — this model began as a Cardano-only view and
   * every Cardano construction site predates the field; only rows from another chain set it.
   *
   * Carried so a row can show a network badge and so the verified filter can exempt chains that have no
   * registry to be verified against (see {@link keepByVerification}).
   */
  readonly chainId?: ChainId
  readonly isAda: boolean
  /**
   * The chain's own money (ADA is covered by `isAda`; NIGHT sets this). Ranks with the base asset instead
   * of falling to the unpriced tail: Midnight has no price source, so a wallet's main Midnight holding
   * would otherwise sort below every priced Cardano token.
   */
  readonly isChainNative?: boolean
  readonly isNft: boolean
  /**
   * Held in a CIP-113 smart wallet: the holder's token, but one that moves through its protocol
   * rather than by an ordinary send.
   *
   * Carried on the asset so the **verified** filter can let it through. It is not in SteelSwap's
   * list and never will be on the day it is minted, so filtering on that would hide an asset the
   * holder demonstrably owns — and its provenance is the on-chain registry, which is a stronger
   * claim than the one that list is making. Same exemption `isAda` already gets, for the same
   * reason: the filter exists to hide spam, and this is not spam.
   */
  readonly isProgrammable?: boolean
  readonly label: string
  /** The fuller name, shown under `label` when it adds information. */
  readonly subtitle?: string
  /** `null` when no source stated the scale — see `TokenInfo.decimals`. */
  readonly decimals: number | null
  readonly quantity: bigint
  /** Value in the active fiat currency, or `null` when unpriced. */
  readonly fiatValue: number | null
}

export type PortfolioAssetType = 'all' | 'tokens' | 'nfts'

export type PortfolioFilter = {
  /** Verified-token id set (SteelSwap `/tokens/list`); membership = "verified". */
  readonly verifiedIds: ReadonlySet<string>
  /** When false, hide anything not verified (ADA is always kept). */
  readonly showUnverified: boolean
  readonly type: PortfolioAssetType
  /** Free-text match against label / id; empty = no text filter. */
  readonly query: string
}

/**
 * Whether to treat an asset as an NFT. The metadata pipeline doesn't classify
 * NFTs (and SteelSwap's registry lists only fungible tokens), so we derive it:
 * a verified/ADA asset is always a fungible token; otherwise the CIP-25/68 mint
 * signature — a single indivisible unit (quantity 1, 0 decimals) — marks an NFT.
 * The stale `isNft` metadata flag is deliberately ignored (it's unreliable).
 */
export const isNftAsset = (a: PortfolioAsset, verifiedIds: ReadonlySet<string>): boolean =>
  // An unknown scale is treated as indivisible here on purpose: a single unit of a
  // token nobody documents is what an NFT looks like from the outside.
  !a.isAda && !verifiedIds.has(a.id) && (a.decimals === 0 || a.decimals === null) && a.quantity === 1n

const matchesQuery = (a: PortfolioAsset, q: string): boolean =>
  q.length === 0 ||
  a.label.toLowerCase().includes(q) ||
  // Searching "WingRiders" should find WRT, now that we keep the fuller name.
  (a.subtitle?.toLowerCase().includes(q) ?? false) ||
  a.id.toLowerCase().includes(q)

/**
 * Filter assets for the portfolio views. ADA always survives the verified gate
 * (the base asset). The NFTs filter bypasses the verified gate (NFTs are never
 * in the fungible registry); Tokens/All apply it. A non-empty query filters by
 * label/id throughout. Order is preserved (filter, don't re-sort).
 */
export const filterPortfolioAssets = (assets: readonly PortfolioAsset[], filter: PortfolioFilter): PortfolioAsset[] => {
  const q = filter.query.trim().toLowerCase()
  return assets.filter((a) => {
    const nft = isNftAsset(a, filter.verifiedIds)
    if (filter.type === 'tokens' && nft) return false
    if (filter.type === 'nfts' && !nft) return false
    if (!matchesQuery(a, q)) return false
    if (a.isAda) return true
    if (filter.type === 'nfts') return true // NFTs aren't in the verified set — show them regardless.
    if (a.isProgrammable === true) return true
    // A chain with no verified registry cannot be filtered against one. The gate exists to hide Cardano
    // spam; applying it to a Midnight holding would hide *everything* the wallet holds there, since no
    // such list exists and every id would be "unverified".
    if (a.chainId !== undefined && a.chainId !== CARDANO_MAINNET) return true
    return filter.showUnverified || filter.verifiedIds.has(a.id)
  })
}

// 0 = ADA, 1 = priced, 2 = unpriced.
const tierOf = (a: PortfolioAsset): number => (a.isAda || a.isChainNative === true ? 0 : a.fiatValue !== null ? 1 : 2)

/**
 * Comparator implementing the order above. ADA sorts ahead of everything; within
 * the priced tier, higher fiat value first (alphabetical tiebreak); the unpriced
 * tier sorts alphabetically by label.
 */
export const comparePortfolioAssets = (a: PortfolioAsset, b: PortfolioAsset): number => {
  const ta = tierOf(a)
  const tb = tierOf(b)
  if (ta !== tb) return ta - tb
  if (ta === 1 && a.fiatValue !== null && b.fiatValue !== null && a.fiatValue !== b.fiatValue) {
    return b.fiatValue - a.fiatValue
  }
  return a.label.localeCompare(b.label)
}

/** A new array of `assets` in display order (see {@link comparePortfolioAssets}). */
export const sortPortfolioAssets = (assets: readonly PortfolioAsset[]): PortfolioAsset[] =>
  [...assets].sort(comparePortfolioAssets)

/** Sum of every priced asset's fiat value, or `null` when nothing is priced. */
export const aggregatePortfolioFiat = (assets: readonly PortfolioAsset[]): number | null => {
  let total = 0
  let anyPriced = false
  for (const a of assets) {
    if (a.fiatValue !== null) {
      total += a.fiatValue
      anyPriced = true
    }
  }
  return anyPriced ? total : null
}
