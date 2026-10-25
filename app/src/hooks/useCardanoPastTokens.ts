/**
 * Tokens this wallet used to hold, as portfolio rows.
 *
 * Selling out of a position removes a token from the portfolio and takes its price chart and its
 * transaction history with it, even though both still describe this wallet's money. `TokenDetailScreen`
 * needs no holding to work — its label and scale fall back to fetched metadata, its activity comes
 * from the tx store, and its chart from `chartAssetFor` — so a row that merely navigates there is
 * enough to get all of it back.
 *
 * Derived from the local balance timeline, so there is no extra data source: the same fold the value
 * chart uses already knows every asset the wallet ever touched.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useMemo, useState} from 'react'
import {logger} from '../logger'
import {type CardanoNetwork, getActiveCardanoNetwork, getCardanoRailConfig} from '../services/cardano/config'
import {getKoiosToken} from '../services/cardano/koios-token'
import {getCardanoAssetsConfig} from '../services/cardano-assets'
import type {PortfolioAsset} from '../services/cardano-assets/portfolio'
import type {TokenInfo} from '../services/cardano-assets/token-metadata'
import {loadTokenInfos} from '../services/cardano-assets/token-store'
import {ADA_KEY, buildBalanceTimeline} from '../services/price-history/balance-timeline'
import {pastTokens} from '../services/price-history/past-tokens'
import {useCardanoPortfolio} from './useCardanoPortfolio'
import {useCardanoTokenHistory} from './useCardanoTokenHistory'

export type PastTokensState = {
  /**
   * Rows for tokens no longer held, most recently held first. `quantity` is `0n` and `fiatValue`
   * `null` — both true, and the reason the row shows when it was last held instead of a balance.
   */
  readonly assets: readonly PortfolioAsset[]
  /** Asset id → unix seconds it was last held, for the row's note. */
  readonly lastHeldById: ReadonlyMap<string, number>
}

const EMPTY: PastTokensState = {assets: [], lastHeldById: new Map()}

const loadInfos = (ids: readonly string[], net: CardanoNetwork): Promise<ReadonlyMap<string, TokenInfo>> => {
  const railCfg = getCardanoRailConfig()
  const koios = railCfg !== null ? {url: railCfg.koiosUrl, token: getKoiosToken(net)} : undefined
  return Effect.runPromise(
    loadTokenInfos(ids, net, getCardanoAssetsConfig(net), koios).pipe(
      Effect.catchAll((e) => {
        logger.warn('Past-token info load failed; those rows stay unnamed', {
          origin: 'useCardanoPastTokens',
          idCount: ids.length,
          error: String(e),
        })
        return Effect.succeed(new Map() as ReadonlyMap<string, TokenInfo>)
      }),
    ),
  )
}

/**
 * Past-holding rows for the active Cardano wallet.
 *
 * Metadata is resolved through the persisted store, which is a cache hit for anything this wallet
 * held while it held it. An id that resolves to nothing still gets a row — the detail screen behind it
 * is exactly where a user goes to find out what an unlabelled token was — labelled by its short id.
 */
export const useCardanoPastTokens = (): PastTokensState => {
  const {txs, loading: historyLoading} = useCardanoTokenHistory(ADA_KEY, true)
  // ⚠️ `loading` matters as much as `assets`. `heldNow` is the *complement* of this list, so an
  // unpainted portfolio does not read as "nothing known yet" — it reads as "everything was sold".
  const {assets, loading: balancesLoading} = useCardanoPortfolio()
  const [state, setState] = useState<PastTokensState>(EMPTY)
  const loading = historyLoading || balancesLoading

  const heldNow = useMemo(() => {
    const keys = new Set<string>()
    for (const a of assets) if (a.quantity > 0n) keys.add(a.isAda ? ADA_KEY : a.id)
    return keys
  }, [assets])

  const past = useMemo(() => pastTokens(buildBalanceTimeline(txs), heldNow), [txs, heldNow])
  // Stable dependency: the effect only refetches when the *set* changes, not on every paging render.
  const pastSig = past.map((p) => p.assetKey).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `past` is captured via the stable `pastSig`.
  useEffect(() => {
    if (loading) return
    if (past.length === 0) {
      setState(EMPTY)
      return
    }
    let active = true
    void loadInfos(
      past.map((p) => p.assetKey),
      getActiveCardanoNetwork(),
    ).then((infos) => {
      if (!active) return
      setState({
        assets: past.map(({assetKey}) => {
          const info = infos.get(assetKey)
          const label = info?.label ?? shortId(assetKey)
          return {
            id: assetKey,
            isAda: false,
            // Not an NFT gallery item: this section is about positions that were exited, and the
            // detail screen renders media for whatever turns out to have it.
            isNft: false,
            label,
            ...(info?.name === undefined || info.name === label ? {} : {subtitle: info.name}),
            decimals: info?.decimals ?? null,
            quantity: 0n,
            fiatValue: null,
          }
        }),
        lastHeldById: new Map(past.map((p) => [p.assetKey, p.lastHeldSec])),
      })
    })
    return () => {
      active = false
    }
  }, [pastSig, loading])

  return state
}

/** The asset-name half of an id, shortened — never invented, just cut. */
const shortId = (assetKey: string): string => {
  const [policy = '', name = ''] = assetKey.split('.')
  return `${(name.length > 0 ? name : policy).slice(0, 10)}…`
}
