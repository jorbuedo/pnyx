/**
 * Stake-pool metadata resolution over our R2-backed pool list (`pools.json`,
 * served R2-direct; see services/data-worker and slow-data.ts). Returns the
 * ticker / name / logo / live parameters for a `pool1…` (or hex key-hash) id, or
 * `null` when the pool is unknown or the list is unavailable — a name is never
 * fabricated (the caller renders the bech32 id as the honest fallback).
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {cexplorerLogoUrl, type PoolDRepConfig} from './config'
import {defaultFetch, type FetchLike} from './http'
import {fetchSlowData} from './slow-data'

export type PoolInfo = {
  /** `pool1…` bech32 (CIP-5). */
  readonly id: string
  /** 28-byte pool key hash, hex. */
  readonly idHex: string
  readonly ticker?: string
  readonly name?: string
  readonly description?: string
  readonly homepage?: string
  /** Pool margin as a fraction (0..1). */
  readonly margin?: number
  /** Pledge, lovelace. */
  readonly pledge?: bigint
  /** Saturation (1.0 = fully saturated). */
  readonly saturation?: number
  readonly delegators?: number
  /** Fixed cost per epoch, lovelace. */
  readonly fixedCost?: bigint
  /** Return on ADA, percent (recent epoch preferred, lifetime fallback). */
  readonly roa?: number
  /** Blocks minted in the most-recently-completed epoch. */
  readonly blocksLastEpoch?: number
  /** Live stake, lovelace. */
  readonly liveStake?: bigint
  readonly status: 'active' | 'retiring'
  /** Derived cexplorer logo URL (always present; Image falls back if it 404s). */
  readonly logoUrl: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))
      ? Number(v)
      : undefined
const big = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return undefined
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Parse one Yoroi Backend Zero pool entry into a `PoolInfo` (null if it has no id). */
const parseEntry = (entry: unknown): PoolInfo | null => {
  const e = record(entry)
  const id = str(e.pool_id)
  if (id === undefined) return null
  const name = record(e.pool_name)
  const update = record(e.pool_update)
  const active = record(update.active)
  const live = record(update.live)
  const chosen = 'margin' in active || 'pledge' in active || 'fixed_cost' in active ? active : live
  const retire = record(record(e.pool_retire).active)
  const status = retire.retiring_epoch !== null && retire.retiring_epoch !== undefined ? 'retiring' : 'active'

  const ticker = str(name.ticker)
  const poolName = str(name.name)
  const description = str(name.description)
  const homepage = str(name.homepage)
  const margin = num(chosen.margin)
  const pledge = big(chosen.pledge)
  const saturation = num(e.saturation)
  const delegators = num(e.delegators)
  const fixedCost = big(chosen.fixed_cost)
  const stats = record(e.stats)
  // Recent-epoch ROA preferred; lifetime is the fallback for young stats windows.
  const roa = num(record(stats.recent).roa) ?? num(record(stats.lifetime).roa)
  // `epochs["0"]` is the most-recently-completed epoch (newest-first keying);
  // `blocks.epoch` would be the current partial epoch and `blocks.total` lifetime.
  const blocksLastEpoch = num(record(record(record(record(e.epochs)['0']).data).block).minted)
  const liveStake = big(e.live_stake)

  return {
    id,
    idHex: str(e.pool_id_hash_raw) ?? '',
    ...(ticker !== undefined ? {ticker} : {}),
    ...(poolName !== undefined ? {name: poolName} : {}),
    ...(description !== undefined ? {description} : {}),
    ...(homepage !== undefined ? {homepage} : {}),
    ...(margin !== undefined ? {margin} : {}),
    ...(pledge !== undefined ? {pledge} : {}),
    ...(saturation !== undefined ? {saturation} : {}),
    ...(delegators !== undefined ? {delegators} : {}),
    ...(fixedCost !== undefined ? {fixedCost} : {}),
    ...(roa !== undefined ? {roa} : {}),
    ...(blocksLastEpoch !== undefined ? {blocksLastEpoch} : {}),
    ...(liveStake !== undefined ? {liveStake} : {}),
    status,
    logoUrl: cexplorerLogoUrl(id),
  }
}

// ── full-list fetch (15-min TTL, keyed by ybz base, in-flight deduped) ──
const LIST_TTL_MS = 15 * 60_000
/**
 * Keyed on the URL the list came from, not on the network that asked for it. A
 * name lookup consults the register whatever network is active, so keying by
 * network would file one list under several names — and, worse, let a caller on
 * one network read a list fetched for another.
 */
const listKey = (config: PoolDRepConfig): string => config.dataUrl ?? `none:${config.network}`

const listCache = new Map<string, {readonly at: number; readonly pools: readonly PoolInfo[]}>()
const listInFlight = new Map<string, Promise<readonly PoolInfo[] | null>>()

/** Test seam: drop cached pool lists so a stubbed fetch is re-read. */
export const resetPoolListCache = (): void => {
  listCache.clear()
  listInFlight.clear()
}

/**
 * Fetch the full stake-pool list for the picker (~hundreds of entries; the
 * server only orders by `ranking`, so all picker sorting is client-side —
 * see `picker-sort.ts`). TTL-cached and in-flight deduped per backend.
 * Transport/parse failure resolves to `null` (picker shows an error state);
 * an empty array is a genuinely empty backend answer.
 */
export const fetchPoolList = (
  config: PoolDRepConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<readonly PoolInfo[] | null> =>
  Effect.gen(function* () {
    const cached = listCache.get(listKey(config))
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.pools

    const inFlight = listInFlight.get(listKey(config))
    if (inFlight !== undefined) return yield* Effect.promise(() => inFlight)

    const load = (async (): Promise<readonly PoolInfo[] | null> => {
      try {
        const body = (await fetchSlowData(config.dataUrl, 'pools', fetchImpl)) as {
          code?: number
          data?: {data?: unknown[]}
        }
        const rows = Array.isArray(body?.data?.data) ? body.data.data : []
        const pools = rows.map(parseEntry).filter((p): p is PoolInfo => p !== null)
        listCache.set(listKey(config), {at: Date.now(), pools})
        return pools
      } catch (e: unknown) {
        // `null` is "no pool list", which the picker renders as an empty search.
        logger.warn('Pool list could not be fetched', {origin: 'pool', error: String(e)})
        return null
      } finally {
        listInFlight.delete(listKey(config))
      }
    })()
    listInFlight.set(listKey(config), load)
    return yield* Effect.promise(() => load)
  })

/**
 * Resolve pool metadata for `poolIdBech32OrHex` from the R2 pool list (the same
 * cached list the picker uses — one fetch shared across callers). A `pool1…` id
 * matches on the bech32 `id`; anything else (a hex key-hash) matches on `idHex`.
 * Unknown pool, or an unavailable list, resolves to `null`.
 */
export const fetchPoolInfo = (
  poolIdBech32OrHex: string,
  config: PoolDRepConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<PoolInfo | null> =>
  Effect.gen(function* () {
    const pools = yield* fetchPoolList(config, fetchImpl)
    if (pools === null) return null
    const byBech = poolIdBech32OrHex.startsWith('pool1')
    return pools.find((p) => (byBech ? p.id === poolIdBech32OrHex : p.idHex === poolIdBech32OrHex)) ?? null
  })
