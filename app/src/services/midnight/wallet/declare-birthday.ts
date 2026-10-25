/**
 * Give a wallet that predates plan item 61(a) a birthday, from a date its owner names.
 *
 * ⚠️ **Only the owner can name it, and that is the whole design.** 61(a) stamps a birthday when this
 * app generates a seed; a wallet created before that has none, and its creation height is not
 * recoverable from the chain. `WalletGroup.createdAt` is the obvious candidate and is **only an upper
 * bound**: for a seed imported from elsewhere it records when *we* first saw it, and a birthday later
 * than the truth skips the blocks between, silently and permanently. So the app proposes the date and
 * the person decides — the completeness claim is theirs, made knowingly, rather than ours, invented.
 *
 * ⚠️ **Declaring one throws away the existing scan.** A commitment tree cannot be collapsed backwards,
 * so starting earlier means rebuilding from nothing. Bounded today, because every coin in the state
 * was found by scanning and will be found again; see `resetShieldedScan` for when that stops being
 * true.
 *
 * @module
 */

import {Effect} from 'effect'

import {logger} from '../../../logger'
import {blockAtOrBefore} from './block-at-time'
import {fetchBlockTimestamp, fetchTipHeight, type ShieldedSyncError} from './shielded-sync'
import {resetShieldedScan, type ShieldedStoreError, saveShieldedBirthday} from './state-store'

const ORIGIN = 'shielded-birthday'

export type DeclareBirthdayOutcome =
  | {readonly kind: 'declared'; readonly height: number; readonly reads: number}
  /** The chain began after the date given, so the whole chain is in scope. */
  | {readonly kind: 'before-genesis'; readonly height: 1}
  | {readonly kind: 'unreadable'; readonly reason: string}

/**
 * Resolve `atMs` to a height, record it as the wallet's birthday, and clear what has been scanned so
 * the next sync starts there.
 *
 * Returns what happened rather than throwing for the ordinary cases: "the chain is younger than this
 * date" is an answer, not a fault, and a caller shows it differently.
 */
export const declareShieldedBirthday = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly network: string
  readonly atMs: number
}): Effect.Effect<DeclareBirthdayOutcome, ShieldedSyncError | ShieldedStoreError> =>
  Effect.gen(function* () {
    const tip = yield* fetchTipHeight(params.network)
    if (tip === null) {
      logger.warn('cannot declare a birthday: the indexer named no tip', {origin: ORIGIN, network: params.network})
      return {kind: 'unreadable', reason: 'the chain tip could not be read'}
    }

    const found = yield* Effect.tryPromise({
      try: () =>
        blockAtOrBefore({
          targetMs: params.atMs,
          tipHeight: tip,
          // Each read is one GraphQL round trip; the search makes about twenty of them on a chain of
          // millions, which is why this is affordable on a phone at all.
          readTimestamp: (height) => Effect.runPromise(fetchBlockTimestamp(params.network, height)),
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.warn('the birthday search could not finish', {origin: ORIGIN, error: String(error)})
          return {kind: 'unreadable' as const, atHeight: 0, reads: 0}
        }),
      ),
    )

    if (found.kind === 'unreadable') {
      return {kind: 'unreadable', reason: `the indexer could not answer for block ${found.atHeight}`}
    }

    // ⚠️ Before-genesis is recorded as **1**, not refused: the person asked to scan from before the
    // chain existed, and block 1 is the honest realisation of that. Reported separately so the screen
    // can say the date was earlier than the chain rather than implying it was used.
    const height = found.kind === 'before-genesis' ? 1 : found.height
    yield* saveShieldedBirthday(params.groupId, params.network, {height, origin: 'declared'})
    yield* resetShieldedScan(params.groupId, params.accountIndex)
    logger.info('a birthday was declared for this wallet', {
      origin: ORIGIN,
      groupId: params.groupId,
      network: params.network,
      height,
      atMs: params.atMs,
    })

    return found.kind === 'before-genesis'
      ? {kind: 'before-genesis', height: 1}
      : {kind: 'declared', height, reads: found.reads}
  })
