/**
 * Where Cardano's in-flight UTxO locks live between runs.
 *
 * `PendingTxTracker` held them in an Effect `Ref`, so a restart between submitting a transaction and
 * the first sync that observes it freed every input it consumed — and that window is exactly when a
 * second build could pick them again. On a phone the window is not theoretical: the app is backgrounded
 * and killed routinely.
 *
 * ## Ids only
 *
 * The rows carry `consumedUtxoIds` and `producedUtxoIds`, never `UTxO.UTxO` objects. A `UTxO.UTxO`
 * cannot be round-tripped — `datum` and `scriptRef` are typed `unknown`, so a faithful codec cannot
 * exist and a lossy one would drop data silently. The same conclusion the send queue reached, for the
 * same reason. A restored entry therefore locks and cascades correctly but exposes no virtual UTxOs
 * until the next sync returns the real ones: chaining pauses across a restart, correctness does not.
 *
 * @module
 */

import type {PersistedPendingTx} from '@pnyx/wallet'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {storage} from '../../platform/storage'

const ORIGIN = 'cardano-pending-tx-store'

/**
 * `@pnyx/cardano/pending-tx/<groupId>/<address>`.
 *
 * The address is in the key because one group can drive several, and a lock belongs to the UTxO set it
 * was taken from.
 */
export const cardanoPendingTxKey = (groupId: string, addressBech32: string): string =>
  `@pnyx/cardano/pending-tx/${groupId}/${addressBech32}`

type StoredRow = {
  txHash?: unknown
  consumedUtxoIds?: unknown
  producedUtxoIds?: unknown
  submittedAt?: unknown
  expiresAt?: unknown
}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * Decode the stored rows, dropping any that is unreadable.
 *
 * A dropped row **unlocks** its inputs, which is the direction that can double-spend — hence the
 * warning. Refusing the whole file instead would unlock all of them, which is strictly worse.
 */
export const parseStoredPendingTxs = (raw: string | null): readonly PersistedPendingTx[] => {
  if (raw === null || raw === '') return []
  let rows: unknown
  try {
    rows = JSON.parse(raw)
  } catch (error) {
    logger.warn('the cardano pending-tx file is not JSON; every input reads as unlocked', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
  if (!Array.isArray(rows)) {
    logger.warn('the cardano pending-tx file is not a list; every input reads as unlocked', {origin: ORIGIN})
    return []
  }
  const out: PersistedPendingTx[] = []
  for (const row of rows as StoredRow[]) {
    if (
      typeof row.txHash !== 'string' ||
      !isStringList(row.consumedUtxoIds) ||
      !isStringList(row.producedUtxoIds) ||
      typeof row.submittedAt !== 'number'
    ) {
      logger.warn('a cardano pending-tx row was malformed; its inputs read as unlocked', {origin: ORIGIN})
      continue
    }
    out.push({
      txHash: row.txHash,
      consumedUtxoIds: row.consumedUtxoIds,
      producedUtxoIds: row.producedUtxoIds,
      submittedAt: row.submittedAt,
      ...(typeof row.expiresAt === 'number' ? {expiresAt: row.expiresAt} : {}),
    })
  }
  return out
}

/**
 * The port `createPendingTxTracker` takes.
 *
 * Both halves swallow their failures deliberately. A read that fails yields no locks, which is the
 * behaviour before this existed; a write that fails must not fail the submit it followed, because the
 * transaction is already gone to the node. Both are logged, because a silently unlocked wallet is
 * exactly what this module exists to prevent.
 */
export const cardanoPendingTxPersistence = (groupId: string, addressBech32: string) => ({
  load: (): Effect.Effect<readonly PersistedPendingTx[]> =>
    Effect.promise(async () => {
      try {
        const rows = parseStoredPendingTxs(await storage.get(cardanoPendingTxKey(groupId, addressBech32)))
        if (rows.length > 0) {
          logger.info('restored in-flight cardano locks from a previous run', {
            origin: ORIGIN,
            groupId,
            rows: rows.length,
          })
        }
        return rows
      } catch (error) {
        logger.warn('could not read the cardano pending-tx locks; starting with none', {
          origin: ORIGIN,
          groupId,
          error: String(error),
        })
        return []
      }
    }),
  save: (rows: readonly PersistedPendingTx[]): Effect.Effect<void> =>
    Effect.promise(async () => {
      try {
        const key = cardanoPendingTxKey(groupId, addressBech32)
        if (rows.length === 0) await storage.remove(key)
        else await storage.set(key, JSON.stringify(rows))
      } catch (error) {
        logger.warn('could not persist the cardano pending-tx locks; a restart will free those inputs', {
          origin: ORIGIN,
          groupId,
          error: String(error),
        })
      }
    }),
})
