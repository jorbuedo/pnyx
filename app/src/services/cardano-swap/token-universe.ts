/**
 * The tradeable-token universe backing the swap "to" picker and the portfolio's
 * verified-token filter — SteelSwap's ranked `GET /api/v2/tokens/list`.
 *
 * Was the keyless V1 `/tokens/list/` dump (~5.5k rows, one shot, filtered
 * locally). That endpoint is SteelSwap's *anonymous-access door* and ends with a
 * disguised credential row, which this module used to ingest as a real token —
 * see `cardano-assets/token-list.ts` for the full account. It now delegates
 * there, which brings server-side search and ranking with it.
 *
 * ⚠️ `decimals` is `null` when SteelSwap does not know them. The picker may show
 * such a token but nothing may format an amount against it.
 *
 * The whole curated set is fetched ONCE and cached for a day, and the picker
 * filters it locally: the list is already in liquidity order (which filtering
 * preserves), and a per-query request would spend a **100/day per-key** quota to
 * buy nothing.
 *
 * @module
 */

import {Effect} from 'effect'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import type {SteelswapError} from '../cardano-assets/steelswap'
import {fetchTokenListAll} from '../cardano-assets/token-list'
import type {FetchLike} from '../cardano-assets/token-metadata'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
const config = () => getCardanoAssetsConfig('mainnet')

/**
 * Upper bound on the curated set we cache for the portfolio filter. The verified
 * universe is a few thousand tokens; this caps the cursor walk so a
 * non-terminating cursor cannot spin.
 */
const MAX_VERIFIED_TOKENS = 6_000

export type TradeableToken = {
  /** App asset id (`policyHex.assetNameHex`). */
  readonly assetId: string
  readonly ticker: string
  readonly name: string
  /** `null` when SteelSwap reports the decimals as unknown. */
  readonly decimals: number | null
}

const toTradeable = (t: {
  readonly assetId: string
  readonly ticker: string | null
  readonly name: string | null
  readonly decimals: number | null
}): TradeableToken => ({
  assetId: t.assetId,
  ticker: t.ticker ?? '',
  name: t.name ?? '',
  decimals: t.decimals,
})

/**
 * The whole curated (verified) universe, for the portfolio's spam filter. Walks
 * the cursor; bounded by {@link MAX_VERIFIED_TOKENS}.
 */
export const fetchTradeableTokens = (
  fetchImpl: FetchLike = defaultFetch,
  nowMs: number = Date.now(),
): Effect.Effect<readonly TradeableToken[], SteelswapError> =>
  fetchTokenListAll(config(), {verifiedOnly: true, sort: 'liquidity'}, MAX_VERIFIED_TOKENS, nowMs, fetchImpl).pipe(
    Effect.map((items) => items.map(toTradeable)),
  )
