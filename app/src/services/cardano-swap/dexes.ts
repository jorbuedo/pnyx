/**
 * The DEX catalog SteelSwap routes across (`GET /api/v2/dexes`).
 *
 * Two consumers: the `ignore` list on a quote (its values are matched against
 * these `id`s — not against the display label a route leg carries), and the
 * venue name + logo shown on route breakdowns and order rows.
 *
 * ⚠️ `logoUrl` is a path **relative to the API host** (served under
 * `/resources`), so it is joined here and never used raw.
 *
 * The catalog changes only with a SteelSwap deployment, so the response carries
 * a 1 h `Cache-Control` and a strong `ETag`. We hold it for the process.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import {type SteelswapError, steelswapAuthedJson} from '../cardano-assets/steelswap'
import type {FetchLike} from '../cardano-assets/token-metadata'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
const config = () => getCardanoAssetsConfig('mainnet')

export type DexKind = 'amm' | 'orderbook'

export type DexInfo = {
  /** The id used everywhere else in the API — this is what `ignore` takes. */
  readonly id: string
  readonly name: string
  readonly kind: DexKind
  /** Absolute logo URL, or `null` when SteelSwap bundles no logo for this DEX. */
  readonly logoUrl: string | null
}

const parseRow = (row: unknown, base: string): DexInfo | null => {
  if (row === null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null
  if (id === null) return null
  const kind: DexKind = r.type === 'orderbook' ? 'orderbook' : 'amm'
  const logo = typeof r.logoUrl === 'string' && r.logoUrl.length > 0 ? r.logoUrl : null
  return {
    id,
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : id,
    kind,
    logoUrl: logo === null ? null : logo.startsWith('http') ? logo : `${base}${logo.startsWith('/') ? '' : '/'}${logo}`,
  }
}

export const fetchDexes = (
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<readonly DexInfo[], SteelswapError> => {
  const cfg = config()
  return steelswapAuthedJson(cfg, '/api/v2/dexes', {}, nowMs, fetchImpl).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as {items?: unknown}
      const rows = Array.isArray(b.items) ? b.items : []
      return rows.map((r) => parseRow(r, cfg.steelswapUrl)).filter((d): d is DexInfo => d !== null)
    }),
  )
}

let cached: readonly DexInfo[] | null = null
let inflight: Promise<readonly DexInfo[]> | null = null

/**
 * Process-cached catalog. A failure resolves to an empty catalog rather than
 * throwing — a missing logo or a raw venue id degrades the display, it must not
 * break a quote — and is not cached, so the next caller retries.
 */
export const getDexes = (nowMs: number, fetchImpl?: FetchLike): Promise<readonly DexInfo[]> => {
  if (cached !== null) return Promise.resolve(cached)
  if (inflight !== null) return inflight
  inflight = Effect.runPromise(Effect.either(fetchDexes(nowMs, fetchImpl)))
    .then((r) => {
      if (r._tag === 'Right') {
        cached = r.right
        return r.right
      }
      logger.warn('SteelSwap DEX catalog unavailable; venues show their raw id and no logo', {
        origin: 'cardano-swap/dexes',
        error: r.left.reason,
      })
      return [] as readonly DexInfo[]
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Test-only: drop the process cache. */
export const resetDexCache = (): void => {
  cached = null
  inflight = null
}
