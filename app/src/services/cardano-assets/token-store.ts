/**
 * Persisted backing for token metadata — a read-through over the `@pnyx/store`
 * token-metadata-table so registry-resolved infos survive across sessions
 * (token metadata is immutable per token, so there is no expiry). The table is
 * bound once at app init (`setCardanoAssetsTokenStore`, from `wallet-service`,
 * the same module-level pattern the night-redeem + cardano-data caches use);
 * when unbound the lookup stays in-memory-only and behaves exactly as before.
 *
 * @module
 */

import type {TokenMetadataTable} from '@pnyx/store/token-metadata-table'
import {Effect} from 'effect'
import {logger} from '../../logger'
import type {CardanoAssetsConfig} from './config'
import {fetchKoiosTokenInfos} from './koios-metadata'
import {fetchTokenInfos, type TokenInfo} from './token-metadata'

/** Koios registry endpoint for the metadata fallback (long-tail decimals). */
export type KoiosMetadataSource = {readonly url: string; readonly token: string | undefined}

let table: TokenMetadataTable | null = null

/** Bind the persisted token-metadata table. Called once at app init. */
export const setCardanoAssetsTokenStore = (t: TokenMetadataTable): void => {
  table = t
}

/** Clear the binding (tests). */
export const clearCardanoAssetsTokenStore = (): void => {
  table = null
}

/** Parse a persisted metadata row payload back into a `TokenInfo`, or `null`
 * when the blob is unusable (a corrupt row is treated as a cache miss). */
export const parseTokenInfoRow = (detailJson: string): TokenInfo | null => {
  try {
    const v = JSON.parse(detailJson) as Partial<TokenInfo>
    if (typeof v.id !== 'string' || typeof v.decimals !== 'number' || typeof v.label !== 'string') return null
    // Older cached rows predate `hasIcon`; default it so the shape stays valid.
    return {...v, hasIcon: v.hasIcon === true} as TokenInfo
  } catch (e: unknown) {
    // `null` is also every shape check above it, so a corrupt cached row and a row we chose to
    // reject are the same answer — and both make the token render unnamed.
    logger.warn('Cached token row could not be read', {origin: 'token-store', error: String(e)})
    return null
  }
}

/** The infos worth persisting: registry-resolved (`known`) only — never the
 * synthetic "unknown" fallback, which would poison the permanent cache. */
export const persistableInfos = (infos: Iterable<TokenInfo>): readonly TokenInfo[] =>
  [...infos].filter((i) => i.known && i.id.length > 0)

/**
 * Resolve infos for `ids`: read persisted rows first (when a store is bound),
 * fetch only the still-missing ids from the registry, then persist the newly
 * resolved (known) ones. Always covers every requested id (unknowns degrade to
 * the synthetic fallback via {@link fetchTokenInfos}). Store failures are
 * swallowed — a cache is best-effort, never a hard dependency.
 */
export const loadTokenInfos = (
  ids: readonly string[],
  network: string,
  config: CardanoAssetsConfig,
  koios?: KoiosMetadataSource,
): Effect.Effect<ReadonlyMap<string, TokenInfo>> =>
  Effect.gen(function* () {
    const out = new Map<string, TokenInfo>()
    const store = table
    if (store !== null) {
      const rows = yield* store.getMany(network, ids).pipe(
        Effect.catchAll((e) => {
          logger.warn('Cached token info read failed; every id is re-fetched', {
            origin: 'CardanoTokenStore',
            idCount: ids.length,
            error: String(e),
          })
          return Effect.succeed([])
        }),
      )
      for (const r of rows) {
        const info = parseTokenInfoRow(r.detailJson)
        if (info !== null) out.set(r.tokenId, info)
      }
    }
    const remaining = ids.filter((id) => !out.has(id))
    if (remaining.length === 0) return out

    const fetched = yield* fetchTokenInfos(remaining, config)
    for (const [id, info] of fetched) out.set(id, info)

    // Koios CIP-26 registry fallback for ids SteelSwap didn't resolve, so a
    // registered long-tail token gets real decimals instead of the 0 fallback.
    const koiosResolved = new Map<string, TokenInfo>()
    if (koios !== undefined) {
      const unknownIds = [...fetched].filter(([, info]) => !info.known).map(([id]) => id)
      if (unknownIds.length > 0) {
        const koiosInfos = yield* fetchKoiosTokenInfos(unknownIds, koios.url, koios.token)
        for (const [id, info] of koiosInfos) {
          out.set(id, info)
          koiosResolved.set(id, info)
        }
      }
    }

    if (store !== null) {
      const toPersist = persistableInfos([...fetched.values(), ...koiosResolved.values()])
      if (toPersist.length > 0) {
        const now = Date.now()
        yield* store
          .putMany(toPersist.map((i) => ({network, tokenId: i.id, detailJson: JSON.stringify(i), fetchedAt: now})))
          .pipe(
            Effect.catchAll((e) => {
              logger.warn('Failed to persist token info', {
                origin: 'CardanoTokenStore',
                infoCount: toPersist.length,
                error: String(e),
              })
              return Effect.void
            }),
          )
      }
    }
    return out
  })
