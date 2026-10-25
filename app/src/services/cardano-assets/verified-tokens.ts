/**
 * Verified-token registry — SteelSwap's `/tokens/list` (~5.5k routable Cardano
 * tokens) treated as the "verified" set, persisted so it survives reloads and
 * paints instantly on cold start. Membership drives the portfolio's spam filter
 * (hide anything not listed) and backs the swap token picker.
 *
 * One session-shared load: both the portfolio filter and the swap picker read
 * the same cache, so the list is fetched at most once per session (and re-used
 * across reloads until the TTL lapses). Pure over `platform/storage` +
 * `fetchTradeableTokens`; no React.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {fetchTradeableTokens, type TradeableToken} from '../cardano-swap/token-universe'
import type {FetchLike} from './token-metadata'

const STORAGE_KEY = '@pnyx/cardano_verified_tokens'
/** Refresh at most daily — the tradeable set changes slowly. */
const TTL_MS = 24 * 60 * 60 * 1000
/** ADA is always verified regardless of the list (its id form is `''` or `'.'`). */
const ADA_IDS: ReadonlySet<string> = new Set(['', '.'])

type CachedList = {readonly fetchedAt: number; readonly tokens: readonly TradeableToken[]}

export type VerifiedTokens = {
  readonly tokens: readonly TradeableToken[]
  readonly verifiedIds: ReadonlySet<string>
}

/** ADA + every listed token id. */
const toResult = (tokens: readonly TradeableToken[]): VerifiedTokens => ({
  tokens,
  verifiedIds: new Set([...ADA_IDS, ...tokens.map((t) => t.assetId)]),
})

/** True for ADA or any token present in the verified set. */
export const isVerifiedId = (verifiedIds: ReadonlySet<string>, id: string): boolean =>
  ADA_IDS.has(id) || verifiedIds.has(id)

const parseCache = (raw: string | null): CachedList | null => {
  if (raw === null) return null
  try {
    const p = JSON.parse(raw) as Partial<CachedList>
    return typeof p.fetchedAt === 'number' && Array.isArray(p.tokens)
      ? {fetchedAt: p.fetchedAt, tokens: p.tokens}
      : null
  } catch (e: unknown) {
    // `null` means "no cached list", so the app refetches — correct, but an unreadable cache
    // refetches on every launch and looks exactly like a cold start.
    logger.warn('Verified-token cache could not be read; treating it as empty', {
      origin: 'verified-tokens',
      error: String(e),
    })
    return null
  }
}

/** Synchronous cached read (MMKV / localStorage) — for instant first paint. `null` on cold cache. */
export const readVerifiedTokensSync = (): VerifiedTokens | null => {
  const cached = parseCache(storage.getSync(STORAGE_KEY))
  return cached === null ? null : toResult(cached.tokens)
}

let inflight: Promise<VerifiedTokens> | null = null

/**
 * Session-shared verified-token load: returns the persisted set when fresh,
 * otherwise fetches + re-persists. On fetch failure falls back to the stale
 * cache (or an empty set) rather than throwing — a missing registry must not
 * break the portfolio, only skip the filter. Memoised for the session.
 */
export const getVerifiedTokens = (nowMs: number, fetchImpl?: FetchLike): Promise<VerifiedTokens> => {
  if (inflight !== null) return inflight
  inflight = (async () => {
    const cached = parseCache(
      await storage.get(STORAGE_KEY).catch((e) => {
        logger.warn('Verified-token cache read failed; refetching the list', {
          origin: 'VerifiedTokens',
          error: String(e),
        })
        return null
      }),
    )
    if (cached !== null && nowMs - cached.fetchedAt < TTL_MS) return toResult(cached.tokens)
    const fetched = await Effect.runPromise(Effect.either(fetchTradeableTokens(fetchImpl)))
    if (fetched._tag === 'Right' && fetched.right.length > 0) {
      await storage
        .set(STORAGE_KEY, JSON.stringify({fetchedAt: nowMs, tokens: fetched.right} satisfies CachedList))
        .catch((e) => {
          logger.warn('Failed to cache the verified-token list; it refetches next session', {
            origin: 'VerifiedTokens',
            error: String(e),
          })
        })
      return toResult(fetched.right)
    }
    return toResult(cached?.tokens ?? [])
  })()
  return inflight
}

/** Test-only: drop the session memo so a fresh load runs. */
export const resetVerifiedTokensCache = (): void => {
  inflight = null
}
