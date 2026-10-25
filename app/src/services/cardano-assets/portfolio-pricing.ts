/**
 * Two pure rules the portfolio enrichment uses to tell "we have no prices *yet*"
 * apart from "this network has no prices at all".
 *
 * `getAdaFiat` returns `null` in both cases, and the enrichment used to treat
 * that single `null` as a failure: it refused to persist the pass and refused to
 * overwrite already-painted rows. On a testnet that condition is permanent, so
 * the very first balance read — the cold, pre-sync one, i.e. zero — became the
 * balance for the rest of the session, and every fresher read after it was
 * dropped on the floor.
 *
 * | showFiat | adaUsd  | pass is authoritative | cache is paintable |
 * |----------|---------|-----------------------|--------------------|
 * | `true`   | number  | yes                   | when any row priced |
 * | `true`   | `null`  | no (prices are down)  | no (never priced)   |
 * | `false`  | `null`  | yes (no market exists)| yes                 |
 *
 * @module
 */

/**
 * Whether an enrichment pass that resolved ADA→USD to `adaUsd` may replace the
 * painted rows and be persisted.
 *
 * Unpriced is the *correct, permanent* state where the network has no fiat, so
 * such a pass is as authoritative as a priced one. Where the network does have
 * fiat, a missing rate means the price source is unavailable right now — that
 * pass must not persist an all-unpriced snapshot over the last good cache.
 */
export const isAuthoritativePass = (adaUsd: number | null, showFiat: boolean): boolean => adaUsd !== null || !showFiat

/**
 * Whether a persisted snapshot may be painted cache-first on cold boot.
 *
 * Where the network has fiat, an all-zero-value snapshot is a stale or failed
 * enrichment that was never successfully priced — painting it flashes an
 * unpriced, mis-ordered portfolio before the live data lands. Where the network
 * has no fiat, every value is zero by construction, so that test would reject
 * every snapshot and the cache would never paint at all.
 */
export const isPaintableCache = (rows: readonly {readonly usdValue: number}[], showFiat: boolean): boolean =>
  rows.length > 0 && (!showFiat || rows.some((r) => r.usdValue > 0))
