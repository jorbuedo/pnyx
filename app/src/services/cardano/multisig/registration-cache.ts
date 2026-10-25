/**
 * What a previous registration search already resolved.
 *
 * Discovery has to see *every* label-1854 registration for the oldest-wins rule
 * to be the rule rather than an approximation, and resolving each one costs a
 * `tx_info` read. Doing that from scratch on every search re-reads a set that only
 * ever grows at the end — so the resolved rows are kept and the next search asks
 * for the tail.
 *
 * **The watermark is the highest block already seen, and `_after_block_height` is
 * inclusive** — verified against Koios rather than assumed: querying with the
 * boundary height returns that block's transactions. So a resume re-reads exactly
 * one block, and the merge de-duplicates it by transaction hash. Storing
 * `height + 1` instead would have been the version of this that silently skips a
 * second registration in the boundary block.
 *
 * **Per network, always.** A preprod registration is not a mainnet one, and a
 * cache keyed without the network would answer a mainnet search with testnet rows.
 *
 * Only ever written from a *complete* read. Both fetches fail loudly rather than
 * returning what survived, so a partial result can never be persisted and then
 * treated as the total view on the next run.
 *
 * @module
 */

import type {CardanoNetwork} from '@pnyx/config'
import type {StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {createProfileStorage} from '../../profile/profile-storage'
import type {RegistrationRow} from './registration-discovery'

/** Bumped when the row shape changes; an older cache is discarded, not migrated. */
const CACHE_VERSION = 1

export const registrationCacheKey = (network: CardanoNetwork): string => `@pnyx/multisig_registrations:${network}`

export type RegistrationCache = {
  /** Highest block height already resolved. `_after_block_height` is inclusive. */
  readonly watermark: number
  readonly rows: readonly RegistrationRow[]
}

const isRow = (v: unknown): v is RegistrationRow => {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.txHash === 'string' &&
    typeof r.blockHeight === 'number' &&
    Array.isArray(r.keyHashes) &&
    Array.isArray(r.scriptHashes)
  )
}

/**
 * Read the cache, or `null` when there is none this build understands.
 *
 * A cache that will not read is not an error — it costs one full search, which is
 * the behaviour before this existed.
 */
export const decodeCache = (raw: string | null): RegistrationCache | null => {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: unknown) {
    // `null` means "not cached", so the registration is re-checked on chain — correct, and an
    // unreadable cache re-checks every time while looking like a cold one.
    logger.warn('Multisig registration cache could not be parsed; re-checking on chain', {
      origin: 'multisig/registration-cache',
      error: String(e),
    })
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const c = parsed as Record<string, unknown>
  if (c.version !== CACHE_VERSION || typeof c.watermark !== 'number') return null
  const rows = (Array.isArray(c.rows) ? c.rows : []).filter(isRow)
  return rows.length === 0 ? null : {watermark: c.watermark, rows}
}

/**
 * Cached rows plus freshly resolved ones, de-duplicated by transaction hash.
 *
 * The fresh row wins a collision. They describe the same transaction, so the two
 * should agree — but if they ever do not, the one just read from the chain is the
 * one to keep.
 */
export const mergeRows = (
  cached: readonly RegistrationRow[],
  fresh: readonly RegistrationRow[],
): readonly RegistrationRow[] => {
  const byHash = new Map(cached.map((row) => [row.txHash, row]))
  for (const row of fresh) byHash.set(row.txHash, row)
  return [...byHash.values()]
}

/** The highest block among these rows, or `undefined` for an empty set. */
export const watermarkOf = (rows: readonly RegistrationRow[]): number | undefined =>
  rows.length === 0 ? undefined : rows.reduce((max, row) => (row.blockHeight > max ? row.blockHeight : max), 0)

const storage = () => createProfileStorage()

export const loadRegistrationCache = (network: CardanoNetwork): Effect.Effect<RegistrationCache | null, StorageError> =>
  Effect.map(storage().get(registrationCacheKey(network)), decodeCache)

export const saveRegistrationCache = (
  network: CardanoNetwork,
  rows: readonly RegistrationRow[],
): Effect.Effect<void, StorageError> => {
  const watermark = watermarkOf(rows)
  if (watermark === undefined) return Effect.void
  return storage().set(
    registrationCacheKey(network),
    JSON.stringify({version: CACHE_VERSION, watermark, rows} satisfies RegistrationCache & {version: number}),
  )
}
