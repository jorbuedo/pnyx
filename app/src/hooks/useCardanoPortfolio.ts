/**
 * Cardano portfolio hook — the single source both the Wallets-home widget and
 * the Portfolio screen read for the asset list + aggregate total. Follows
 * an assets-table pattern:
 *
 *  1. **Cache-first paint** — read the persisted assets (SQLite, sorted by
 *     usd_value desc) and render immediately on cold boot.
 *  2. **Enrich + persist** — resolve the live balance (rail), token metadata,
 *     and USD prices; compute each asset's USD value; `replaceAll` the partition.
 *  3. **Display** — convert stored USD → the active fiat via one linear FX
 *     factor (`adaFiat / adaUsd`, both from SteelSwap), sort via the shared
 *     portfolio comparator, and sum for the total.
 *
 * Storing USD (not the display currency) keeps the single value index valid for
 * any currency, and lets EUR be derived from SteelSwap's ADA quotes even though
 * SteelSwap has no direct USD→EUR rate.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import type {AssetRow} from '@pnyx/store/assets-table'
import type {WalletBalance} from '@pnyx/wallet'
import {Effect} from 'effect'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {networkCapabilities} from '../config/network-capabilities'
import {logger} from '../logger'
import {useConfig, useWalletData, useWalletList} from '../providers'
import {getActiveCardanoNetwork, getCardanoRailConfig} from '../services/cardano/config'
import {getKoiosToken} from '../services/cardano/koios-token'
import {
  ADA_ASSET_IDS,
  adaTokenInfo,
  assetIdToUnit,
  getCardanoAssetsConfig,
  unknownTokenInfo,
} from '../services/cardano-assets'
import {aggregatePortfolioFiat, type PortfolioAsset, sortPortfolioAssets} from '../services/cardano-assets/portfolio'
import {isAuthoritativePass, isPaintableCache} from '../services/cardano-assets/portfolio-pricing'
import {fromAssetRow, type PortfolioDetail, toAssetRow} from '../services/cardano-assets/portfolio-row'
import {getAdaFiat, getTokenAdaSpots} from '../services/cardano-assets/price-cache'
import {loadTokenInfos} from '../services/cardano-assets/token-store'
import {useCardanoRail} from './useCardanoRail'
import {useVerifiedTokens} from './useVerifiedTokens'
import {isStaleScope, rowsForScope, type WalletScoped, walletScopeKey, writeScoped} from './wallet-scope'

/** Who asked for a refetch. Only the user's own pull gesture may drive the pull spinner. */
export type RefreshSource = 'pull' | 'background'

export type CardanoPortfolio = {
  /** Assets in display order (ADA → priced desc → unpriced alpha). */
  readonly assets: readonly PortfolioAsset[]
  /** Aggregate fiat total (active currency), or null when nothing is priced. */
  readonly totalFiat: {readonly value: number; readonly currency: string} | null
  /** ADA base-unit quantity, for the crypto sub-line; null while unresolved. */
  readonly adaQuantity: bigint | null
  /** True until the first paint (cache or live). */
  readonly loading: boolean
  /**
   * True only while a *pull-to-refresh* is in flight.
   *
   * ⚠️ Nothing else may set this. It drives `RefreshControl`, which pins the scroll view and shows
   * the system spinner while it is true — so when the on-focus refetch shared this flag, every
   * cold boot, wallet switch and network switch put the home screen into a refreshing state the
   * user had not asked for and had to wait out.
   */
  readonly refreshing: boolean
  /** True while any fetch is in flight, whoever started it. Drives the progress line. */
  readonly busy: boolean
  /** Re-fetch balance + prices now. `'pull'` marks the user's own pull-to-refresh gesture. */
  readonly refresh: (source?: RefreshSource) => void
  /** True when the rail has no configured endpoint / address. */
  readonly unavailable: boolean
}

type DecodedRow = {readonly detail: PortfolioDetail; readonly usdValue: number}

/** Stable identity, so "no rows for this wallet" does not re-render every consumer. */
const EMPTY_ROWS: readonly DecodedRow[] = []

const network = getActiveCardanoNetwork

/** ADA is 6 decimals by protocol — not something a registry could fail to state. */
const ADA_TOKEN_DECIMALS = 6

/** Stable fingerprint of a balance (primary + every secondary id:qty), used to
 * skip the redundant post-sync re-enrich when the synced balance is unchanged. */
const balanceSignature = (bal: WalletBalance): string =>
  `${bal.primary.quantity}|${bal.secondary
    .map((s) => `${s.id}:${s.quantity}`)
    .sort()
    .join(',')}`

export const useCardanoPortfolio = (): CardanoPortfolio => {
  const {rail, unavailable} = useCardanoRail()
  const {listAssetsForWallet, saveAssetsForWallet} = useWalletData()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {currency} = useConfig()
  // Verified registry (shared, session-memoised) — pricing is gated to it so
  // spam/unverified tokens cost no price fetch and never inflate the total.
  const {verifiedIds} = useVerifiedTokens()
  const groupId = selectedWalletGroup?.groupId ?? null

  // Rows carry the wallet they describe; see `wallet-scope` for why that is a
  // scoping rule rather than a reset in an effect.
  const walletKey = walletScopeKey(groupId, selectedAccountIndex)
  const [painted, setPainted] = useState<WalletScoped<DecodedRow>>({key: walletKey, rows: EMPTY_ROWS})
  const rows = rowsForScope(painted, walletKey, EMPTY_ROWS)
  const setRows = useCallback(
    (next: readonly DecodedRow[] | ((prev: readonly DecodedRow[]) => readonly DecodedRow[])) => {
      setPainted((prev) => writeScoped(prev, walletKey, next, EMPTY_ROWS))
    },
    [walletKey],
  )
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // A fetch is in flight. Distinct from `refreshing`, which is the pull gesture alone.
  const [fetching, setFetching] = useState(true)
  const [fx, setFx] = useState<number | null>(null)
  // Pricing timestamp — the price caches key their TTL off it. Bumping it via
  // refresh() re-runs the live enrichment effect, which is how pull-to-refresh
  // and the on-focus refetch force fresh balance + prices.
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback((source: RefreshSource = 'background') => {
    if (source === 'pull') setRefreshing(true)
    setFetching(true)
    setNow(Date.now())
  }, [])

  /** A fetch has settled: the pull spinner retracts and the progress line goes out together. */
  const endFetch = useCallback(() => {
    setRefreshing(false)
    setFetching(false)
  }, [])

  // 1. Cache-first paint from the persisted (usd_value-sorted) partition.
  useEffect(() => {
    if (groupId === null) return
    let active = true
    void listAssetsForWallet(groupId, selectedAccountIndex).then((persisted) => {
      if (!active || persisted.length === 0) return
      const decoded = persisted.map(fromAssetRow).filter((r): r is NonNullable<typeof r> => r !== null)
      if (isPaintableCache(decoded, networkCapabilities(network()).showFiat)) {
        setRows(decoded)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [groupId, selectedAccountIndex, listAssetsForWallet, setRows])

  // 2. Live enrichment: balance → metadata + USD prices → rows → persist.
  useEffect(() => {
    if (rail === null || groupId === null) return
    let active = true
    // A new rail means a new wallet or a new network, and nothing has been fetched for it yet.
    setFetching(true)
    const net = network()
    const cfg = getCardanoAssetsConfig(net)
    const railCfg = getCardanoRailConfig()
    const koios = railCfg !== null ? {url: railCfg.koiosUrl, token: getKoiosToken(net)} : undefined
    const ref = {groupId, chainId: CARDANO_MAINNET, accountIndex: selectedAccountIndex}
    // Skip the redundant post-sync re-enrich (metadata reload + persist) when the
    // synced balance matches the one already written. Set only after an
    // authoritative pass, so a pass made blind by a down price source never
    // blocks the retry that would fill the fiat in.
    let writtenSig: string | null = null

    const enrich = async (bal: WalletBalance): Promise<void> => {
      const sig = balanceSignature(bal)
      if (sig === writtenSig) return
      const secondaryIds = bal.secondary.map((s) => s.id)
      const adaUsd = await getAdaFiat('USD', now, cfg)
      const infos = await Effect.runPromise(loadTokenInfos(secondaryIds, net, cfg, koios))
      const unitById = new Map<string, string>()
      for (const id of secondaryIds) {
        // Price verified tokens only — unverified/spam are hidden by default and
        // left unpriced (they still render, with no fiat, when revealed).
        if (!verifiedIds.has(id)) continue
        const unit = assetIdToUnit(id)
        if (unit !== null && unit.length > 0) unitById.set(id, unit)
      }
      // Token spots are only useful once we can price ADA in USD.
      const spots =
        adaUsd !== null && unitById.size > 0
          ? await getTokenAdaSpots([...unitById.values()], now, cfg)
          : new Map<string, number>()

      const out: AssetRow[] = []
      const adaQty = bal.primary.quantity
      const adaUsdValue = adaUsd !== null ? (Number(adaQty) / 10 ** ADA_TOKEN_DECIMALS) * adaUsd : 0
      out.push(toAssetRow(ref, adaTokenInfo(net), adaQty, adaUsdValue))
      for (const {id, quantity} of bal.secondary) {
        const info = infos.get(id) ?? unknownTokenInfo(id)
        const unit = unitById.get(id)
        const spot = unit !== undefined ? spots.get(unit) : undefined
        // An unknown scale cannot be priced: the same raw quantity could be worth
        // 1 or 1,000,000 depending on the decimals nobody told us.
        const assetNumber = info.decimals === null ? null : Number(quantity) / 10 ** info.decimals
        const usdValue =
          adaUsd !== null && spot !== undefined && !info.isNft && assetNumber !== null ? spot * adaUsd * assetNumber : 0
        out.push(toAssetRow(ref, info, quantity, usdValue))
      }
      const decoded = out.map(fromAssetRow).filter((r): r is NonNullable<typeof r> => r !== null)

      // Prices unavailable *right now* (the network has fiat, the source is down):
      // don't persist an all-unpriced snapshot over the last good cache, and don't
      // clobber already-painted rows — just seed balances if nothing has painted
      // yet. Where the network has no fiat at all, unpriced is the correct answer
      // and the pass proceeds normally — see `portfolio-pricing.ts`.
      if (!isAuthoritativePass(adaUsd, networkCapabilities(net).showFiat)) {
        if (active) {
          setRows((prev) => (prev.length > 0 ? prev : decoded))
          setLoading(false)
          endFetch()
        }
        return
      }

      await saveAssetsForWallet(groupId, selectedAccountIndex, out)
      writtenSig = sig
      if (active) {
        setRows(decoded)
        setLoading(false)
        endFetch()
      }
    }

    // Cached-first balance, then a background re-sync — strictly in that order.
    //
    // These two ran concurrently until 2026-07-31, and nothing ordered their
    // `setRows`. When the synced balance resolved first, the *cached* one landed
    // second and overwrote a correct balance with a stale one — reliably visible on
    // the Wallets tab, which re-runs this on every focus, while the Portfolio screen
    // (mounted once) usually got the luckier interleaving and showed the right
    // figure. The `sig === writtenSig` skip cannot prevent it: it compares balance
    // content, and only a pass that actually wrote sets it.
    //
    // Awaiting in sequence is the whole fix: the synced value is strictly fresher, so
    // it must be the last writer. The cost is that the sync starts after the cached
    // read resolves, which is a local cache hit.
    void (async () => {
      try {
        await enrich(await Effect.runPromise(rail.balance))
      } catch (e: unknown) {
        // The cached read. Failing here leaves the screen on whatever it last painted, which is
        // indistinguishable from a wallet that simply has not changed.
        logger.warn('Cardano portfolio cached balance read failed; the previous figures stand', {
          origin: 'useCardanoPortfolio',
          error: String(e),
        })
        if (active) endFetch()
      }
      if (!active) return
      try {
        await enrich(
          await Effect.runPromise(
            rail.sync.pipe(
              Effect.catchAll((e) => {
                logger.warn('Rail sync failed; the portfolio reads the cached balance', {
                  origin: 'useCardanoPortfolio',
                  error: String(e),
                })
                return Effect.void
              }),
              Effect.zipRight(rail.balance),
            ),
          ),
        )
      } catch (e: unknown) {
        logger.warn('Cardano portfolio sync failed; the cached figures stand', {
          origin: 'useCardanoPortfolio',
          error: String(e),
        })
        if (active) endFetch()
      }
    })()

    return () => {
      active = false
    }
  }, [rail, groupId, selectedAccountIndex, now, saveAssetsForWallet, verifiedIds, setRows, endFetch])

  // FX factor USD → active currency (adaFiat / adaUsd, both from SteelSwap).
  useEffect(() => {
    let active = true
    // USD is the stored denomination — the conversion is the identity, so no live
    // price call is needed. This keeps cached USD balances rendering instantly
    // even when the price API is unavailable (a live-quote failure must not blank
    // an already-known balance).
    if (currency === 'USD') {
      setFx(1)
      return
    }
    const cfg = getCardanoAssetsConfig(network())
    void Promise.all([getAdaFiat('USD', now, cfg), getAdaFiat(currency, now, cfg)]).then(([usd, display]) => {
      if (!active) return
      setFx(usd !== null && usd > 0 && display !== null ? display / usd : null)
    })
    return () => {
      active = false
    }
  }, [currency, now])

  const assets = useMemo(() => {
    const list: PortfolioAsset[] = rows.map(({detail, usdValue}) => ({
      id: detail.id,
      isAda: ADA_ASSET_IDS.has(detail.id),
      isNft: detail.isNft,
      label: detail.label,
      ...(detail.subtitle !== undefined ? {subtitle: detail.subtitle} : {}),
      decimals: detail.decimals,
      quantity: BigInt(detail.quantity),
      fiatValue: fx !== null && usdValue > 0 ? usdValue * fx : null,
    }))
    return sortPortfolioAssets(list)
  }, [rows, fx])

  const adaQuantity = useMemo(() => assets.find((a) => a.isAda)?.quantity ?? null, [assets])

  const totalValue = useMemo(() => aggregatePortfolioFiat(assets), [assets])
  // A settled wallet whose balances are all zero is worth exactly $0 — surface
  // that instead of the `null` (unpriced) total, which the hero renders as a
  // perpetual loading gap. Gated on `!loading` so nothing flashes 0 mid-fetch.
  const isEmpty = useMemo(() => assets.length > 0 && assets.every((a) => a.quantity === 0n), [assets])
  // On a testnet there is no fiat at all, so an empty wallet is *unpriced*, not
  // worth zero — `$0.00` there would be a fiat figure we have no basis for.
  const showFiat = networkCapabilities(network()).showFiat
  // Nothing has painted for *this* wallet yet, which is a load however settled the
  // previous wallet's fetch was. Without it the switch reports `loading: false` over an
  // empty list, and the hero draws a confident zero for a wallet holding funds.
  const isLoading = loading || isStaleScope(painted, walletKey)
  const totalFiat =
    totalValue !== null
      ? {value: totalValue, currency}
      : !isLoading && isEmpty && showFiat
        ? {value: 0, currency}
        : null

  return {
    assets,
    totalFiat,
    adaQuantity,
    loading: isLoading,
    refreshing,
    busy: fetching || isLoading,
    refresh,
    unavailable,
  }
}
