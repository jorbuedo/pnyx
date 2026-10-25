/**
 * Midnight indexer client — one GraphQL read of `dustGenerationStatus` for a Cardano reward
 * address.
 *
 * Keyed by the reward address because that is what the registration datum's `c_wallet`
 * identifies, so no extra key derivation is needed: the same stake credential the Cardano
 * scan already works from.
 *
 * ⚠️ **The endpoint follows the caller's network, and is never read from the environment.** DUST
 * generation is about NIGHT held on Cardano, so a wallet on Cardano mainnet needs the Midnight
 * *mainnet* indexer here even when the forum identity lives on preprod — which is exactly why this
 * cannot be a build-time constant. It resolves through `../midnight/networks.ts`, the one module that
 * owns endpoint policy. An unknown network reports `unavailable` rather than reaching for a default.
 *
 * A cross-network value degrades rather than lies: the indexer refuses a mainnet reward address on
 * preprod (`wrong Cardano network: expected stake_test, was stake`), so the read reports unavailable
 * and `registration-health.ts` decides from Cardano alone. Worth knowing when reading that fallback —
 * it is load-bearing, not vestigial.
 *
 * Never fails: every error path resolves to a snapshot. An indexer outage is a missing
 * signal, not a broken screen, and the Cardano-side diagnosis stands on its own.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {indexerAuthHeaders} from '../midnight/indexer-auth'
import {midnightIndexerFor} from '../midnight/networks'
import type {DustGenerationRow, DustGenerationSnapshot} from './observability'

const ORIGIN = 'midnight-dust-indexer'

const QUERY = `query DustGenerationStatus($addresses: [CardanoRewardAddress!]!) {
  dustGenerationStatus(cardanoRewardAddresses: $addresses) {
    registered
    dustAddress
    nightBalance
    generationRate
    currentCapacity
    maxCapacity
  }
}`

/** A scalar the indexer may send as string or number, as the string this module works in. */
const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

const toRow = (raw: Record<string, unknown>): DustGenerationRow => ({
  registered: raw.registered === true,
  ...(asString(raw.dustAddress) === undefined ? {} : {dustAddress: asString(raw.dustAddress) as string}),
  ...(asString(raw.nightBalance) === undefined ? {} : {nightBalance: asString(raw.nightBalance) as string}),
  ...(asString(raw.generationRate) === undefined ? {} : {generationRate: asString(raw.generationRate) as string}),
  ...(asString(raw.currentCapacity) === undefined ? {} : {currentCapacity: asString(raw.currentCapacity) as string}),
  ...(asString(raw.maxCapacity) === undefined ? {} : {maxCapacity: asString(raw.maxCapacity) as string}),
})

/** Interpret a GraphQL response body into a snapshot. Exported for tests — no IO. */
export const snapshotFromBody = (json: unknown): DustGenerationSnapshot => {
  const body = (json ?? {}) as {
    data?: {dustGenerationStatus?: unknown}
    errors?: readonly {message?: unknown}[]
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    logger.warn('DUST indexer returned errors', {origin: ORIGIN, errors: body.errors})
    return {kind: 'unavailable'}
  }
  const rows = body.data?.dustGenerationStatus
  if (!Array.isArray(rows)) return {kind: 'unavailable'}
  const row = rows[0]
  // An empty array is a real answer — the indexer knows of no registration for this address —
  // whereas a malformed body is not an answer at all. Only the latter is `unavailable`.
  if (rows.length === 0) return {kind: 'none'}
  if (row === null || typeof row !== 'object') return {kind: 'unavailable'}
  return {kind: 'ok', row: toRow(row as Record<string, unknown>)}
}

/** Read generation status for one reward (stake) address. Never fails. */
export const fetchDustGenerationStatus = (
  stakeAddress: string,
  /** The Midnight network matching this reward address's Cardano network. */
  network: string | null,
): Effect.Effect<DustGenerationSnapshot> =>
  Effect.gen(function* () {
    const url = midnightIndexerFor(network)
    if (url === null) return {kind: 'unavailable'} as const

    const json = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {accept: 'application/json', 'content-type': 'application/json', ...indexerAuthHeaders(url)},
          body: JSON.stringify({query: QUERY, variables: {addresses: [stakeAddress]}}),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as unknown
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.tapError((cause) => Effect.sync(() => logger.warn('DUST indexer read failed', {origin: ORIGIN, cause}))),
      Effect.orElseSucceed(() => null),
    )

    return json === null ? ({kind: 'unavailable'} as const) : snapshotFromBody(json)
  })
