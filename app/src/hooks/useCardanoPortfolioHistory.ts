/**
 * Portfolio & asset price history for the value chart. Composes the pure
 * price-history spine with live data:
 *
 *  - Balances come from the LOCAL tx store (via {@link useCardanoTokenHistory}),
 *    folded into a per-asset step timeline and anchored to the current on-chain
 *    balances — no indexer.
 *  - Prices: **ADA→fiat from Kraken**, priced **directly in the active fiat**
 *    (its own Kraken pair) so historical values are accurate per fiat — no FX
 *    approximation. **token→ADA from SteelSwap OHLCV**; a token's fiat =
 *    `tokenAda × adaFiat`. Both read-through the persisted price-point cache.
 *  - `value(t) = Σ balance(t) × price_fiat(t)`, sampled at the range's resolution.
 *
 * The aggregate prices the same set the hero totals: ADA + every verified held
 * token. A token with no SteelSwap history contributes nothing (never a
 * fabricated 0).
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {logger} from '../logger'
import {useConfig} from '../providers'
import {type CardanoNetwork, getActiveCardanoNetwork, getCardanoRailConfig} from '../services/cardano/config'
import {getKoiosToken} from '../services/cardano/koios-token'
import {assetIdToUnit, getCardanoAssetsConfig} from '../services/cardano-assets'
import type {PortfolioAsset} from '../services/cardano-assets/portfolio'
import {fetchTokenAdaOhlcv, steelswapBackingOff} from '../services/cardano-assets/steelswap'
import type {TokenInfo} from '../services/cardano-assets/token-metadata'
import {loadTokenInfos} from '../services/cardano-assets/token-store'
import {isVerifiedId} from '../services/cardano-assets/verified-tokens'
import {
  ADA_KEY,
  anchorTimeline,
  type BalanceTimeline,
  buildBalanceTimeline,
  heldAssetKeys,
  heldWindow,
} from '../services/price-history/balance-timeline'
import {makeKrakenPriceSource} from '../services/price-history/kraken'
import {asFiatSymbol} from '../services/price-history/port'
import {portfolioAt} from '../services/price-history/portfolio-snapshot'
import {type ChartRange, pointCountFor, rangeWindow, steelswapOhlcvParams} from '../services/price-history/range'
import {loadMajorFiatSeries, loadTokenAdaSeries, type TokenAdaFetcher} from '../services/price-history/series'
import {buildValueSeries, evenTimestamps, pointsResolver, type ValuePoint} from '../services/price-history/valuation'
import {reasonOfFailure} from '../utils/effect-failure'
import {useCardanoPortfolio} from './useCardanoPortfolio'
import {useCardanoTokenHistory} from './useCardanoTokenHistory'
import {useNetworkCapabilities} from './useNetworkCapabilities'
import {useVerifiedTokens} from './useVerifiedTokens'

/** ADA decimals (its timeline key is the empty string). */
const ADA_DECIMALS = 6

/** An asset the value series can price: a real scale, and a unit to fetch a series for (ADA aside). */
type PricedAsset = {
  readonly key: string
  readonly unit: string | null
  readonly decimals: number
  readonly quantity: bigint
  readonly label: string
  readonly subtitle?: string
}

/** A charted asset: ADA (Kraken) or a native token by SteelSwap `unit` (token→ADA). */
export type ChartAsset = {readonly kind: 'ada'} | {readonly kind: 'token'; readonly unit: string}

/** A standalone price chart's ALL window reaches back ~2 years (source horizon). */
const ALL_PRICE_LOOKBACK_SEC = 2 * 365 * 86400

/** Resolution for the per-tx fiat resolver: daily over the activity span (~1y back). */
const ACTIVITY_RANGE: ChartRange = '1Y'

/**
 * The chartable descriptor for a portfolio asset: ADA, a token with a resolvable
 * unit, or `null` (e.g. a malformed id). Callers gate NFTs separately.
 */
export const chartAssetFor = (assetId: string, isAda: boolean): ChartAsset | null => {
  if (isAda) return {kind: 'ada'}
  const unit = assetIdToUnit(assetId)
  return unit !== null && unit.length > 0 ? {kind: 'token', unit} : null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

const network = getActiveCardanoNetwork

/**
 * A short label for an asset with no resolved metadata — the asset-name hex, or the policy's head
 * when the name is empty. Never invented: it is the id, shortened.
 */
const shortAssetLabel = (assetKey: string): string => {
  const [policy = '', name = ''] = assetKey.split('.')
  if (name.length > 0) {
    const decoded = hexToUtf8(name)
    return decoded ?? `${name.slice(0, 8)}…`
  }
  return `${policy.slice(0, 8)}…`
}

/** Printable ASCII asset names are conventionally hex-encoded UTF-8; anything else stays hex. */
const hexToUtf8 = (hex: string): string | null => {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isFinite(byte)) return null
    bytes[i] = byte
  }
  // Reject control bytes rather than drawing replacement characters into a label.
  if (bytes.some((b) => b < 0x20 || b > 0x7e)) return null
  return new TextDecoder().decode(bytes)
}

/**
 * Priceable descriptors for assets the wallet no longer holds, restricted to those whose held window
 * overlaps `window` — an asset sold before the chart starts cannot move it, so neither its metadata
 * nor its OHLCV is worth fetching.
 *
 * Verified-only, mirroring the held set: an unverified token is not priced into a total there either.
 */
const resolveFormerAssets = async (
  formerKeys: readonly string[],
  rawTimeline: BalanceTimeline,
  window: {readonly fromSec: number; readonly toSec: number},
  net: CardanoNetwork,
  verifiedIds: ReadonlySet<string>,
): Promise<readonly PricedAsset[]> => {
  const candidates = formerKeys.filter((key) => {
    if (!isVerifiedId(verifiedIds, key)) return false
    const held = heldWindow(rawTimeline, key)
    return held !== null && held.fromSec <= window.toSec && held.toSec >= window.fromSec
  })
  if (candidates.length === 0) return []
  const railCfg = getCardanoRailConfig()
  const koios = railCfg !== null ? {url: railCfg.koiosUrl, token: getKoiosToken(net)} : undefined
  const infos = await Effect.runPromise(
    loadTokenInfos(candidates, net, getCardanoAssetsConfig(net), koios).pipe(
      Effect.catchAll((e) => {
        logger.warn('Token info load failed; those assets stay unpriced', {
          origin: 'useCardanoPortfolioHistory',
          candidateCount: candidates.length,
          error: String(e),
        })
        return Effect.succeed(new Map() as ReadonlyMap<string, TokenInfo>)
      }),
    ),
  )
  const out: PricedAsset[] = []
  for (const key of candidates) {
    const info = infos.get(key)
    if (info === undefined || info.decimals === null) continue
    const unit = assetIdToUnit(key)
    if (unit === null || unit.length === 0) continue
    out.push({
      key,
      unit,
      decimals: info.decimals,
      // Sold out: the anchor target is zero, so the series comes back down instead of trailing.
      quantity: 0n,
      label: info.label,
      ...(info.name === undefined || info.name === info.label ? {} : {subtitle: info.name}),
    })
  }
  return out
}

/** A SteelSwap token→ADA OHLCV fetcher for a range (empty on any failure). */
const makeTokenAdaFetcher = (): TokenAdaFetcher => (unit, range) => {
  const {interval, numIntervals} = steelswapOhlcvParams(range)
  // ⚠️ **While SteelSwap is parked, asking is pure noise.** The client short-circuits a throttled call
  // locally, so one request per held token — about thirty on a wallet with a real portfolio — produced
  // thirty warnings per render and no data either way. Measured after a 429: `steelswap backoff 21627s`,
  // the six-hour clamp, repeating for as long as the screen was open. The empty series is the same
  // answer, arrived at without the noise.
  if (steelswapBackingOff(Date.now())) {
    logger.debug('SteelSwap is parked; the token series stays empty', {
      origin: 'useCardanoPortfolioHistory',
      unit,
    })
    return Promise.resolve([] as readonly {ts: number; value: number}[])
  }
  return Effect.runPromise(
    fetchTokenAdaOhlcv(unit, interval, numIntervals, getCardanoAssetsConfig(network()), Date.now()).pipe(
      Effect.catchAll((e) => {
        logger.warn('Token OHLCV fetch failed; the series renders empty', {
          origin: 'useCardanoPortfolioHistory',
          unit,
          // `String(e)` on the tagged error renders only "SteelswapError" — see `reasonOfFailure`.
          error: reasonOfFailure(e),
        })
        return Effect.succeed([] as readonly {ts: number; value: number}[])
      }),
    ),
  )
}

export type ChartSeriesState = {
  /** Sampled `{ts, value}` points in the active fiat, ascending; empty while unpriced. */
  readonly series: readonly ValuePoint[]
  /** True until the first series resolves for the current range. */
  readonly loading: boolean
  /** Active fiat code the values are denominated in (for the axis / delta label). */
  readonly currency: string
  /**
   * The portfolio as it stood at an instant — the rows behind a scrubbed point, so the list can
   * agree with the chart about the past. `null` until the first series resolves, and always `null`
   * for a single-asset chart, which has no portfolio behind it.
   */
  readonly snapshotAt: ((tsSec: number) => readonly PortfolioAsset[]) | null
}

/** Step-resolver composing a token's fiat price: `tokenAda(t) × adaFiat(t)`. */
const composeTokenFiat =
  (adaFiat: (ts: number) => number | null, tokenAda: (ts: number) => number | null) =>
  (ts: number): number | null => {
    const a = adaFiat(ts)
    const t = tokenAda(ts)
    return a === null || t === null ? null : a * t
  }

/**
 * Aggregate portfolio value over `range`, in the active fiat — ADA (Kraken,
 * priced directly in the fiat) plus every verified token the wallet held **at
 * any point in the window**, not only the ones it holds now (SteelSwap
 * token→ADA × ADA→fiat).
 *
 * Charting only *current* holdings rewrites history to look like today's basket
 * always existed: a wallet that swapped all its NIGHT for GENS showed nothing
 * for the NIGHT before the trade, so the total stepped up at the swap and value
 * appeared out of nowhere. The balance timeline already carries every asset the
 * wallet ever touched — this asks it for them.
 */
export const useCardanoPortfolioHistory = (range: ChartRange): ChartSeriesState => {
  const {currency} = useConfig()
  const {showFiat} = useNetworkCapabilities()
  const {txs, loading: txLoading} = useCardanoTokenHistory(ADA_KEY, true)
  const {assets} = useCardanoPortfolio()
  const {verifiedIds} = useVerifiedTokens()
  const fiat = asFiatSymbol(currency)
  const source = useMemo(() => makeKrakenPriceSource(), [])
  const fetchOhlcv = useMemo(() => makeTokenAdaFetcher(), [])
  const attempted = useRef(new Set<string>())
  const [series, setSeries] = useState<readonly ValuePoint[]>([])
  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<{readonly at: (tsSec: number) => readonly PortfolioAsset[]} | null>(null)

  const rawTimeline = useMemo(() => buildBalanceTimeline(txs), [txs])
  const walletStart = useMemo(() => {
    let min: number | null = null
    for (const steps of rawTimeline.values()) {
      const first = steps[0]
      if (first !== undefined && (min === null || first.ts < min)) min = first.ts
    }
    return min
  }, [rawTimeline])

  // The priced set from *current* holdings — ADA + verified, held (non-NFT) tokens with a resolvable
  // unit. Keyed by timeline asset key (ADA = ''); carries current balance + decimals for anchoring
  // and value math. Assets the wallet no longer holds are added in the effect, which needs an async
  // metadata read to know their scale.
  const priced = useMemo(() => {
    const out: PricedAsset[] = []
    for (const a of assets) {
      // A value series needs a real scale: valuing a raw base-unit count as whole
      // tokens would be wrong by orders of magnitude, so an asset with unknown
      // decimals is left out of the total rather than distorting it.
      if (a.decimals === null) continue
      if (a.isAda) {
        out.push({key: ADA_KEY, unit: null, decimals: a.decimals, quantity: a.quantity, label: a.label})
        continue
      }
      if (a.isNft || a.quantity === 0n || !isVerifiedId(verifiedIds, a.id)) continue
      const unit = assetIdToUnit(a.id)
      if (unit === null || unit.length === 0) continue
      out.push({
        key: a.id,
        unit,
        decimals: a.decimals,
        quantity: a.quantity,
        label: a.label,
        ...(a.subtitle === undefined ? {} : {subtitle: a.subtitle}),
      })
    }
    return out
  }, [assets, verifiedIds])

  /**
   * Asset keys in the timeline that current holdings do not cover — sold out entirely, or held in a
   * quantity of zero. These are the ones the aggregate used to drop.
   */
  const formerKeys = useMemo(() => {
    const held = new Set(priced.map((p) => p.key))
    return heldAssetKeys(rawTimeline).filter((k) => k !== ADA_KEY && !held.has(k))
  }, [priced, rawTimeline])

  useEffect(() => {
    if (txLoading) return
    // Testnet holdings have no market: the Kraken ADA series prices *mainnet*
    // ADA, so charting it against tADA balances would invent a portfolio value.
    if (fiat === null || !showFiat) {
      setSeries([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    const now = nowSec()
    const window = rangeWindow(range, now, walletStart)
    const spec = pointCountFor(range)
    const net = network()

    void (async () => {
      // Assets no longer held: their scale comes from the persisted metadata store (token metadata is
      // immutable, so a token this wallet once held is normally already cached). Only a `known` scale
      // qualifies — an unresolved one would mis-price by orders of magnitude, the same rule the held
      // set follows. Restricted to the window: an asset sold long before it starts cannot affect it.
      const former = await resolveFormerAssets(formerKeys, rawTimeline, window, net, verifiedIds)
      if (!active) return
      const charted: readonly PricedAsset[] = [...priced, ...former]
      // Former assets anchor to a current balance of zero. Without the explicit entry
      // `anchorTimeline` passes their raw cumulative steps through untouched, leaving a tail that
      // never comes back down.
      const balancesNow = new Map(charted.map((p) => [p.key, p.quantity]))
      // Anchor to the current on-chain balance so the tip is always the real
      // value (raw cumulative history can be partial/inverted mid-sync).
      const timeline = anchorTimeline(rawTimeline, balancesNow, window.fromSec)

      const adaFiat = pointsResolver(
        await loadMajorFiatSeries(source, net, 'ADA', fiat, window, range, attempted.current),
      )
      const resolvers = new Map<string, (ts: number) => number | null>()
      resolvers.set(ADA_KEY, adaFiat)
      // Token→ADA series in parallel; compose each into an active-fiat resolver.
      await Promise.all(
        charted
          .filter((p) => p.key !== ADA_KEY && p.unit !== null)
          .map(async (p) => {
            const pts = await loadTokenAdaSeries(fetchOhlcv, net, p.unit as string, window, range, attempted.current)
            resolvers.set(p.key, composeTokenFiat(adaFiat, pointsResolver(pts)))
          }),
      )
      if (!active) return
      const samples = evenTimestamps(window.fromSec, window.toSec, spec)
      const byKey = new Map(charted.map((p) => [p.key, p]))
      const decimalsOf = (key: string) => byKey.get(key)?.decimals ?? ADA_DECIMALS
      const resolver = (key: string, ts: number) => resolvers.get(key)?.(ts) ?? null
      const assetKeys = charted.map((p) => p.key).filter((k) => timeline.has(k))
      setSeries(buildValueSeries(timeline, samples, resolver, decimalsOf, assetKeys))
      // Wrapped in an object: a bare function in state would be taken for a reducer.
      setSnapshot({
        at: (tsSec: number) =>
          portfolioAt(
            timeline,
            tsSec,
            (key) => {
              const p = byKey.get(key)
              return p === undefined
                ? {label: shortAssetLabel(key), decimals: null}
                : {label: p.label, decimals: p.decimals, ...(p.subtitle === undefined ? {} : {subtitle: p.subtitle})}
            },
            resolver,
            verifiedIds,
          ),
      })
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [range, rawTimeline, priced, formerKeys, walletStart, source, fetchOhlcv, fiat, txLoading, showFiat, verifiedIds])

  return {series, loading: loading || txLoading, currency, snapshotAt: snapshot?.at ?? null}
}

/**
 * A single asset's price over `range`, in the active fiat (token-detail chart).
 * ADA → Kraken (priced in the fiat); a token → `tokenAda × adaFiat`. `ALL`
 * reaches back ~2 years.
 */
export const useCardanoAssetPriceHistory = (asset: ChartAsset | null, range: ChartRange): ChartSeriesState => {
  const {currency} = useConfig()
  const {showFiat} = useNetworkCapabilities()
  const fiat = asFiatSymbol(currency)
  const source = useMemo(() => makeKrakenPriceSource(), [])
  const fetchOhlcv = useMemo(() => makeTokenAdaFetcher(), [])
  const attempted = useRef(new Set<string>())
  const [series, setSeries] = useState<readonly ValuePoint[]>([])
  const [loading, setLoading] = useState(true)
  // `null` = ADA; a unit = token; `undefined` = not chartable (skip entirely).
  const kind = asset === null ? 'none' : asset.kind
  const unit = asset !== null && asset.kind === 'token' ? asset.unit : null

  useEffect(() => {
    if (kind === 'none' || fiat === null || !showFiat) {
      setSeries([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    const now = nowSec()
    const window = rangeWindow(range, now, range === 'ALL' ? now - ALL_PRICE_LOOKBACK_SEC : null)
    const spec = pointCountFor(range)
    const net = network()
    void (async () => {
      const adaFiat = pointsResolver(
        await loadMajorFiatSeries(source, net, 'ADA', fiat, window, range, attempted.current),
      )
      const price =
        unit === null
          ? adaFiat
          : composeTokenFiat(
              adaFiat,
              pointsResolver(await loadTokenAdaSeries(fetchOhlcv, net, unit, window, range, attempted.current)),
            )
      if (!active) return
      const points = evenTimestamps(window.fromSec, window.toSec, spec)
        .map((ts) => {
          const value = price(ts)
          return value === null ? null : {ts, value}
        })
        .filter((p): p is ValuePoint => p !== null)
      setSeries(points)
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [kind, unit, fiat, range, source, fetchOhlcv, showFiat])

  // No portfolio behind a single-asset chart, so nothing to snapshot.
  return {series, loading, currency, snapshotAt: null}
}

/** Fiat value of `rawQuantity` of `assetKey` **at** `tsSec` (null when unknown). */
export type FiatAtTime = (
  assetKey: string,
  rawQuantity: bigint,
  decimals: number,
  tsSec: number | null,
) => {readonly value: number; readonly currency: string} | null

/**
 * Per-tx fiat-at-time for the activity list: prices each row's amount at the
 * transaction's timestamp (not the current rate). Loads ADA (Kraken) + each
 * involved token (SteelSwap) at daily resolution over the activity span, and
 * returns a resolver. A tx older than the source horizon (or an unpriced token)
 * yields `null` — no fiat shown rather than a misleading current-rate figure.
 */
export const useActivityFiat = (txs: readonly ReviewedTransaction[]): FiatAtTime => {
  const {currency} = useConfig()
  const {showFiat} = useNetworkCapabilities()
  const fiat = asFiatSymbol(currency)
  const source = useMemo(() => makeKrakenPriceSource(), [])
  const fetchOhlcv = useMemo(() => makeTokenAdaFetcher(), [])
  const attempted = useRef(new Set<string>())
  const [resolvers, setResolvers] = useState<ReadonlyMap<string, (ts: number) => number | null>>(new Map())

  const involved = useMemo(() => {
    const keys = new Set<string>()
    let minTs: number | null = null
    for (const tx of txs) {
      if (tx.timestamp !== undefined) {
        const ms = Date.parse(tx.timestamp)
        if (Number.isFinite(ms)) {
          const s = Math.floor(ms / 1000)
          minTs = minTs === null ? s : Math.min(minTs, s)
        }
      }
      for (const d of tx.ownDelta) keys.add(d.assetId ?? ADA_KEY)
    }
    return {keys: [...keys].sort(), minTs}
  }, [txs])
  // Stable dependency string so the effect only re-runs when the asset set /
  // span actually changes (not on every paging re-render).
  const involvedKey = `${involved.keys.join(',')}|${involved.minTs ?? ''}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: `involved` is captured via the stable `involvedKey`.
  useEffect(() => {
    if (involved.minTs === null || fiat === null || !showFiat) return
    let active = true
    const net = network()
    const window = {fromSec: involved.minTs, toSec: nowSec()}
    void (async () => {
      const adaFiat = pointsResolver(
        await loadMajorFiatSeries(source, net, 'ADA', fiat, window, ACTIVITY_RANGE, attempted.current),
      )
      const map = new Map<string, (ts: number) => number | null>()
      map.set(ADA_KEY, adaFiat)
      await Promise.all(
        involved.keys
          .filter((k) => k !== ADA_KEY)
          .map(async (key) => {
            const unit = assetIdToUnit(key)
            if (unit === null || unit.length === 0) return
            const tAda = pointsResolver(
              await loadTokenAdaSeries(fetchOhlcv, net, unit, window, ACTIVITY_RANGE, attempted.current),
            )
            map.set(key, composeTokenFiat(adaFiat, tAda))
          }),
      )
      if (active) setResolvers(map)
    })()
    return () => {
      active = false
    }
  }, [involvedKey, fiat, source, fetchOhlcv, showFiat])

  return useCallback(
    (assetKey, rawQuantity, decimals, tsSec) => {
      if (tsSec === null) return null
      const price = resolvers.get(assetKey.length > 0 ? assetKey : ADA_KEY)
      if (price === undefined) return null
      const unit = price(tsSec)
      if (unit === null) return null
      return {value: (Number(rawQuantity) / 10 ** decimals) * unit, currency}
    },
    [resolvers, currency],
  )
}
