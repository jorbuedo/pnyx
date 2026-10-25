/**
 * React hooks over the Cardano asset-data services: batched token metadata,
 * image URLs, and fiat conversion bound to the active network + fiat setting.
 * No react-query in this app — a module-level TTL cache + an `active`-guarded
 * effect (the WalletProvider pattern) backs the hooks.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useMemo, useState} from 'react'
import {logger} from '../../logger'
import {useConfig} from '../../providers'
import {getActiveCardanoNetwork, getCardanoRailConfig, onCardanoNetworkChange} from '../cardano/config'
import {getKoiosToken} from '../cardano/koios-token'
import {assetIdToUnit} from './asset-id'
import {assetMediaIconUrl, cexplorerIconUrl, getCardanoAssetsConfig} from './config'
import {knownTokenIconUri, nftPlaceholderIconUri} from './known-token-icons'
import {fetchKoiosTokenInfos} from './koios-metadata'
import {getAdaFiat, getTokenAdaSpots} from './price-cache'
import {tokenIconUrl} from './steelswap'
import {resolveTokenIconUri} from './token-icon-cache'
import {ADA_ASSET_IDS, ADA_TOKEN_INFO, adaTokenInfo, type TokenInfo, unknownTokenInfo} from './token-metadata'
import {loadTokenInfos} from './token-store'

const network = getActiveCardanoNetwork

// ── token metadata cache (infos rarely change; cache for the session) ──
const infoCache = new Map<string, TokenInfo>()

/** Resolve infos for `ids`, cached across the session; missing ids fetch once. */
export const useTokenInfos = (ids: readonly string[]): {infos: ReadonlyMap<string, TokenInfo>; loading: boolean} => {
  const key = useMemo(() => [...new Set(ids)].sort().join(','), [ids])
  const [infos, setInfos] = useState<ReadonlyMap<string, TokenInfo>>(() => new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    const wanted = key.length > 0 ? key.split(',') : []
    const missing = wanted.filter((id) => !infoCache.has(id))
    if (missing.length === 0) {
      setInfos(new Map(wanted.map((id) => [id, infoCache.get(id) ?? unknownTokenInfo(id)])))
      return
    }
    setLoading(true)
    const net = network()
    const rail = getCardanoRailConfig()
    const koios = rail !== null ? {url: rail.koiosUrl, token: getKoiosToken(net)} : undefined
    void Effect.runPromise(loadTokenInfos(missing, net, getCardanoAssetsConfig(net), koios))
      .then((fetched) => {
        for (const [id, info] of fetched) infoCache.set(id, info)
        if (!active) return
        setInfos(new Map(wanted.map((id) => [id, infoCache.get(id) ?? unknownTokenInfo(id)])))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [key])

  return {infos, loading}
}

// ── detail-only media/NFT enrichment (one asset, one request, session-cached) ──
const detailCache = new Map<string, TokenInfo | null>()

/**
 * The asset's own on-chain metadata: media URI, and whether it is an NFT.
 *
 * A DETAIL-screen hook: it asks Koios `/asset_info` for ONE asset, so it must not
 * be used from a list. `useTokenInfos` cannot answer this — its Koios step only
 * runs for ids SteelSwap failed to resolve, and SteelSwap happily returns a ticker
 * for assets that are actually NFTs (it listed a Cardania founder card as a
 * fungible), which shadowed the CIP-25 metadata that says otherwise.
 *
 * Returns the base info merged with what the chain says, so the caller always has
 * something to render.
 */
export const useAssetDetailInfo = (assetId: string, base: TokenInfo | undefined): TokenInfo | undefined => {
  const [enriched, setEnriched] = useState<TokenInfo | null>(() => detailCache.get(assetId) ?? null)

  useEffect(() => {
    if (assetId.length === 0 || ADA_ASSET_IDS.has(assetId)) return
    const cached = detailCache.get(assetId)
    if (cached !== undefined) {
      setEnriched(cached)
      return
    }
    const rail = getCardanoRailConfig()
    if (rail === null) return
    let active = true
    void Effect.runPromise(fetchKoiosTokenInfos([assetId], rail.koiosUrl, getKoiosToken(network())))
      .then((map) => {
        const row = map.get(assetId) ?? null
        detailCache.set(assetId, row)
        if (active) setEnriched(row)
      })
      .catch((e) => {
        logger.warn('Token detail enrichment failed', {origin: 'cardano-assets/hooks', assetId, error: String(e)})
      })
    return () => {
      active = false
    }
  }, [assetId])

  if (enriched === null) return base
  if (base === undefined) return enriched
  const isNft = base.isNft || enriched.isNft
  // For an NFT the chain's name wins: a DEX ticker for a one-of-one is a poor
  // heading ("CDFC6" where the mint says "Cardania Founder's Card - Green"). For a
  // fungible the curated ticker stays authoritative.
  const label = isNft && enriched.name !== undefined ? enriched.name : base.label
  return {
    ...base,
    ...(enriched.name !== undefined ? {name: enriched.name} : {}),
    ...(enriched.image !== undefined ? {image: enriched.image} : {}),
    ...(enriched.mediaType !== undefined ? {mediaType: enriched.mediaType} : {}),
    label,
    isNft,
  }
}

// ── token icon cache (unit → resolved SteelSwap uri | null; once per session) ──
const iconCache = new Map<string, string | null>()

/**
 * Units the icon CDN has answered with its generic placeholder.
 *
 * ⚠️ **The verdict can only be reached after the image loads**, so the placeholder is on screen for a
 * moment before it is replaced. Remembering it makes that a once-per-token event for the session
 * rather than once per mount — a long list recycles rows constantly, so without this the same token
 * re-fetched and re-flashed every time it scrolled back into view.
 */
const iconlessUnits = new Set<string>()

/** Record that the CDN has no real icon for this asset. Idempotent. */
export const rememberIconlessAsset = (assetId: string): void => {
  const unit = assetIdToUnit(assetId)
  if (unit !== null && unit.length > 0) iconlessUnits.add(unit)
}

// All three caches key on a bare asset id, which the same policy can mint on more
// than one network — drop them when the rail moves.
onCardanoNetworkChange(() => {
  infoCache.clear()
  iconCache.clear()
  iconlessUnits.clear()
})

export type TokenIconSources = {
  /** SteelSwap icon — downscaled cached `file://` on native, CDN URL on web. */
  readonly primary: string | null
  /** cexplorer icon URL — the fallback (real icon or a generic placeholder). */
  readonly fallback: string | null
}

/**
 * Ordered icon sources for `assetId`: the SteelSwap icon (resolved through the
 * on-device resize cache) then the cexplorer CDN fallback. The caller chains
 * them (primary → fallback → initials). `''`/ADA yields no sources.
 */
export const useTokenIconUri = (assetId: string, opts: {readonly isNft?: boolean} = {}): TokenIconSources => {
  const unit = assetIdToUnit(assetId)
  /**
   * What we ship wins outright — no network, no cache, no fallback.
   *
   * The CDNs below index *listed tokens*, so for an NFT they have nothing of its own: cexplorer
   * answers almost everything with a generic placeholder, which cost two requests per row to fetch
   * somebody else's. A branded mark (a handle) beats everything.
   *
   * Failing that, an NFT tries the **first-party media host** — the one source that does hold NFT
   * artwork, where both CDNs below have nothing. A miss is a 404 and `TokenIcon` chains
   * `primary → noIcon → initials`, so an asset the backfill has not reached yet renders exactly
   * what it rendered before: the shipped mark. Full-resolution artwork remains `assetMediaUrl`'s
   * job on detail surfaces; this is a 256px-ceiling icon for list rows.
   */
  // Already established to have no icon: ask for nothing — no CDN request, and no placeholder frame.
  const iconless = unit !== null && iconlessUnits.has(unit)
  const shipped = knownTokenIconUri(assetId)
  // blake2b per row is not free in a long list, so derive once per asset id rather than per render.
  const nftMedia = useMemo(
    () => (shipped !== null || opts.isNft !== true ? null : assetMediaIconUrl(assetId)),
    [assetId, shipped, opts.isNft],
  )
  const known = shipped ?? nftMedia ?? (opts.isNft === true ? nftPlaceholderIconUri() : null)
  const fallback = known !== null || iconless || unit === null ? null : cexplorerIconUrl(unit)
  const [primary, setPrimary] = useState<string | null>(
    () => known ?? (unit !== null && iconCache.has(unit) ? (iconCache.get(unit) ?? null) : null),
  )

  useEffect(() => {
    if (known !== null) {
      setPrimary(known)
      return
    }
    if (iconless) {
      // The SteelSwap resolve is skipped too: this asset has already been shown to have no icon.
      setPrimary(null)
      return
    }
    if (unit === null || unit.length === 0) {
      setPrimary(null)
      return
    }
    if (iconCache.has(unit)) {
      setPrimary(iconCache.get(unit) ?? null)
      return
    }
    const url = tokenIconUrl(unit, getCardanoAssetsConfig(network()))
    if (url === null) {
      setPrimary(null)
      return
    }
    let active = true
    void resolveTokenIconUri(unit, url)
      .then((resolved) => {
        iconCache.set(unit, resolved)
        if (active) setPrimary(resolved)
      })
      .catch((e) => {
        logger.warn('Token icon did not resolve', {origin: 'cardano-assets/hooks', unit, error: String(e)})
        if (active) setPrimary(null)
      })
    return () => {
      active = false
    }
  }, [unit, known, iconless])

  return useMemo(() => ({primary, fallback}), [primary, fallback])
}

type PriceSnapshot = {readonly ada: number | null; readonly tokens: ReadonlyMap<string, number>}

export type AssetFiat = {readonly value: number; readonly currency: string}

/**
 * A converter `(assetId, rawQuantity, decimals) → {value, currency} | null`
 * for the active fiat setting. Rates come from the shared {@link getAdaFiat} /
 * {@link getTokenAdaSpots} caches (ADA→fiat per currency, token→ADA per unit),
 * so overlapping ids across screens/rows collapse to one request each; unpriced
 * assets and unsupported currencies → null.
 */
export const useAssetFiat = (
  ids: readonly string[],
  nowMs: number,
): ((assetId: string, rawQuantity: bigint, decimals: number) => AssetFiat | null) => {
  const {currency} = useConfig()
  const key = useMemo(() => `${currency}:${[...new Set(ids)].sort().join(',')}`, [currency, ids])
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null)

  useEffect(() => {
    let active = true
    const cfg = getCardanoAssetsConfig(network())
    const idList = key.slice(key.indexOf(':') + 1)
    const idArr = idList.length > 0 ? idList.split(',') : []
    const unitById = new Map<string, string>()
    for (const id of idArr) {
      if (ADA_ASSET_IDS.has(id)) continue
      const unit = assetIdToUnit(id)
      if (unit !== null && unit.length > 0) unitById.set(id, unit)
    }
    void Promise.all([getAdaFiat(currency, nowMs, cfg), getTokenAdaSpots([...unitById.values()], nowMs, cfg)]).then(
      ([ada, spots]) => {
        const tokens = new Map<string, number>()
        if (ada !== null) {
          for (const [id, unit] of unitById) {
            const spot = spots.get(unit)
            if (spot !== undefined) tokens.set(id, spot * ada)
          }
        }
        if (active) setSnapshot({ada, tokens})
      },
    )
    return () => {
      active = false
    }
  }, [key, currency, nowMs])

  return useMemo(
    () => (assetId, rawQuantity, decimals) => {
      if (snapshot === null) return null
      const isAda = assetId === '' || assetId === '.'
      const unit = isAda ? snapshot.ada : (snapshot.tokens.get(assetId) ?? null)
      if (unit === null) return null
      const scaled = Number(rawQuantity) / 10 ** decimals
      return {value: scaled * unit, currency}
    },
    [snapshot, currency],
  )
}

export {ADA_TOKEN_INFO, adaTokenInfo, unknownTokenInfo, type TokenInfo}
