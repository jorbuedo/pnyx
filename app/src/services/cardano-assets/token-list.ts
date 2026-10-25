/**
 * SteelSwap's ranked, searchable token list (`GET /api/v2/tokens/list`).
 *
 * Replaces the legacy keyless V1 `/tokens/list/` dump for both consumers — the
 * swap "to" picker and the portfolio's verified-token filter. Three reasons:
 *
 * 1. **Search and ranking move server-side.** `sort` is liquidity / 24h volume /
 *    virtual TVL, `search` matches ticker or name (or an exact `unit`), and the
 *    page is cursor-paginated instead of a 5.5k-row array we filter locally.
 * 2. **`verified` is a real field**, not "present in the dump".
 * 3. ⚠️ **The V1 dump ends with a disguised credential row.** SteelSwap
 *    documents `GET /tokens/list/` as the anonymous-access door: the catalog is
 *    followed by ONE sentinel row, always last, carrying a freshly-minted anon
 *    API credential dressed as a token (live: ticker/name `"Nike"`, a 56-hex
 *    `policyId`, `sources: []`). The old parser only checked the policy length,
 *    so that row became a phantom tradeable token, entered the "verified" set
 *    the portfolio spam filter trusts, and was persisted to plaintext storage.
 *    The V2 endpoint has no such row.
 *
 * ⚠️ `decimals` is `null` when SteelSwap reports `decimalsKnown === false`. The
 * API sends `0` as the unknown-decimals fallback, so trusting the number would
 * render every such token as an integer count of base units. Never format an
 * amount whose decimals are `null`.
 *
 * @module
 */

import {Effect} from 'effect'
import {unitToAssetId} from './asset-id'
import type {CardanoAssetsConfig} from './config'
import {type SteelswapError, steelswapAuthedJson} from './steelswap'
import type {FetchLike} from './token-metadata'

/** Ranking metric over the ADA-tradeable universe. */
export type TokenListSort = 'liquidity' | 'volume24h' | 'virtualTvl'

export type TokenListItem = {
  /** SteelSwap unit (`policyIdHex + assetNameHex`; `''` for ADA). */
  readonly unit: string
  /** App asset id (`"policy.name"`). */
  readonly assetId: string
  readonly ticker: string | null
  readonly name: string | null
  /** `null` when SteelSwap does not know them — never format against this. */
  readonly decimals: number | null
  readonly verified: boolean
  /** ADA-denominated metrics; each `null` when the metric is unknown. */
  readonly priceAda: number | null
  readonly liquidityAda: number | null
  readonly volume24hAda: number | null
  readonly logoUrl: string | null
}

export type TokenListPage = {
  readonly items: readonly TokenListItem[]
  /** Opaque cursor for the next page; `null` on the last page. */
  readonly cursor: string | null
}

export type TokenListQuery = {
  /** 1–200; the API defaults to 50. */
  readonly limit?: number
  readonly cursor?: string | null
  readonly search?: string | null
  readonly sort?: TokenListSort
  /** Curated tokens only. The API defaults to `true`. */
  readonly verifiedOnly?: boolean
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One `TokenListItem` from a `TokenListItem` row, or `null` when the row carries
 * no resolvable unit. `decimals` survives only when `decimalsKnown` is true.
 */
export const parseTokenListRow = (row: unknown): TokenListItem | null => {
  if (row === null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const token = (r.token ?? {}) as Record<string, unknown>
  const unit = typeof token.unit === 'string' ? token.unit : null
  if (unit === null) return null
  const assetId = unitToAssetId(unit)
  if (assetId === null) return null
  const decimalsKnown = token.decimalsKnown === true
  const decimals = decimalsKnown && typeof token.decimals === 'number' && token.decimals >= 0 ? token.decimals : null
  return {
    unit,
    assetId,
    ticker: str(token.ticker),
    name: str(token.name),
    decimals,
    verified: r.verified === true,
    priceAda: num(r.priceAda),
    liquidityAda: num(r.liquidityAda),
    volume24hAda: num(r.volume24hAda),
    logoUrl: str(token.logoUrl),
  }
}

const queryString = (q: TokenListQuery): string => {
  const p: string[] = []
  if (q.limit !== undefined) p.push(`limit=${q.limit}`)
  if (q.cursor != null && q.cursor.length > 0) p.push(`cursor=${encodeURIComponent(q.cursor)}`)
  // The API ignores an empty/whitespace-only search, so don't send one.
  const search = q.search?.trim()
  if (search !== undefined && search.length > 0) p.push(`search=${encodeURIComponent(search)}`)
  if (q.sort !== undefined) p.push(`sort=${q.sort}`)
  if (q.verifiedOnly !== undefined) p.push(`verifiedOnly=${q.verifiedOnly}`)
  return p.length === 0 ? '' : `?${p.join('&')}`
}

/**
 * One page of the ranked token list.
 *
 * ⚠️ The cursor encodes a position in the ranked, filtered list, so it is only
 * meaningful while `sort`, `search` and `verifiedOnly` are unchanged. Reset it
 * whenever any of those change, or the page walks a list that no longer exists.
 */
export const fetchTokenList = (
  config: CardanoAssetsConfig,
  query: TokenListQuery,
  nowMs: number,
  fetchImpl: FetchLike,
): Effect.Effect<TokenListPage, SteelswapError> =>
  steelswapAuthedJson(config, `/api/v2/tokens/list${queryString(query)}`, {}, nowMs, fetchImpl).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as {items?: unknown; cursor?: unknown}
      const rows = Array.isArray(b.items) ? b.items : []
      return {
        items: rows.map(parseTokenListRow).filter((t): t is TokenListItem => t !== null),
        cursor: str(b.cursor),
      }
    }),
  )

/**
 * Walk the cursor to collect up to `max` tokens — for the verified-token set,
 * which needs the whole curated universe rather than one page.
 *
 * Bounded on purpose: `max` caps the walk so a cursor that never terminates
 * cannot spin forever, and the count that was reached is what the caller gets.
 */
export const fetchTokenListAll = (
  config: CardanoAssetsConfig,
  query: TokenListQuery,
  max: number,
  nowMs: number,
  fetchImpl: FetchLike,
): Effect.Effect<readonly TokenListItem[], SteelswapError> =>
  Effect.gen(function* () {
    const out: TokenListItem[] = []
    let cursor: string | null = query.cursor ?? null
    while (out.length < max) {
      const page: TokenListPage = yield* fetchTokenList(config, {...query, limit: 200, cursor}, nowMs, fetchImpl)
      out.push(...page.items)
      if (page.cursor === null || page.items.length === 0) break
      cursor = page.cursor
    }
    return out.slice(0, max)
  })
