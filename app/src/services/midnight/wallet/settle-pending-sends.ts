/**
 * Matching this wallet's pending sends against what the chain showed, and reporting each one's fate.
 *
 * ⚠️ **This is the only place a send's outcome is ever learned.** The sponsor answers "accepted" and
 * nothing after, so the wallet finds out by recognising the transaction on chain — by identifier, since
 * a device-built transaction never had a hash. A send that passes its window without appearing is
 * *abandoned*: a node-level rejection (a bad fee, an expired TTL) leaves no row anywhere, so absence is
 * the only evidence there will ever be.
 *
 * ⚠️ **Absence is only evidence on the unshielded rail.** A shielded transfer has no unshielded output
 * of ours and therefore never appears in this feed at all, so it was abandoned on every occasion,
 * including the ones where it landed. Those are asked of the chain by identifier instead —
 * `askChainAboutShielded`, over `identifier-lookup.ts`.
 *
 * Its own module because **both** readers of the unshielded feed have to run it. The one-shot sync did,
 * and the live feed must too — otherwise a send that lands while the feed is open is never recognised,
 * its DUST spend never promoted and its inputs never unlocked. Importing it from `unshielded.ts` would
 * make that pair circular.
 *
 * @module
 */

import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {
  type DustStoreError,
  discardPendingDustSpend,
  loadPendingDustSpend,
  promotePendingDustSpend,
} from './dust-state-store'
import {type IdentifiedTransaction, lookupByIdentifier} from './identifier-lookup'
import type {MidnightActivity} from './midnight-activity'
import {type PendingSend, resolvePendingSends} from './pending-send'
import {loadPendingSends, removePendingSends} from './pending-send-store'
import {releaseUnshieldedLocks} from './unshielded-pending-store'

const ORIGIN = 'midnight-unshielded'

/**
 * A bookkeeping read or write failed while settling what the sync saw.
 *
 * Module-private: nothing outside can act on it, because {@link settlePendingSends} is defined never to
 * fail — the UTxO set is already stored and correct by then, and losing the bookkeeping is better
 * reported than propagated. It exists so those failures travel typed to the one place that logs them,
 * rather than as a bare rejection.
 */
class SettlementError extends Data.TaggedError('SettlementError')<{readonly reason: string}> {}

const settlementStep = <A>(run: () => Promise<A>): Effect.Effect<A, SettlementError> =>
  Effect.tryPromise({try: run, catch: (error) => new SettlementError({reason: String(error)})})

/**
 * Match this wallet's pending sends against what the sync saw, and report each one's fate.
 *
 * ⚠️ **This is the only place a send's outcome is ever learned.** The sponsor answers "accepted" and
 * nothing after, so the wallet finds out by recognising the transaction on chain — by identifier, since
 * it never had a hash. A send that passes its window without appearing is *abandoned*: a node-level
 * rejection (a bad fee, an expired TTL) leaves no row anywhere, so absence is the only evidence there
 * will ever be.
 *
 * Failures here never fail the sync: the UTxO set is already stored and correct, and losing the
 * bookkeeping is worse reported than propagated.
 */
/**
 * Whether the standing pending DUST spend belongs to this send.
 *
 * Matched on identifiers because a device-built transaction has no hash. Containment rather than
 * equality: a sponsored transaction carries the sponsor's identifiers too, so the device's are a
 * subset of what lands. A self-funded one is not sponsored, but matching the same way costs nothing and
 * keeps one rule.
 */
const pendingDustSpendMatches = (
  groupId: string,
  accountIndex: number,
  identifiers: readonly string[],
): Effect.Effect<boolean, DustStoreError> =>
  Effect.gen(function* () {
    if (identifiers.length === 0) return false
    const pending = yield* loadPendingDustSpend(groupId, accountIndex, Math.floor(Date.now() / 1000))
    if (pending === undefined || pending.identifiers.length === 0) return false
    return pending.identifiers.every((id) => identifiers.includes(id))
  })

/** A pending send is keyed by the identifiers it was recorded with — it has no id of its own. */
const sendKey = (send: PendingSend): string => send.identifiers.join('|')

type ShieldedVerdicts = {
  /** Shielded sends the chain has, with the transaction that carried them. */
  readonly landed: readonly {readonly send: PendingSend; readonly found: IdentifiedTransaction}[]
  /** Sends whose lookup could not be completed. They stay pending — absence was never established. */
  readonly unanswered: ReadonlySet<string>
}

/**
 * Ask the chain about the shielded sends this feed cannot see.
 *
 * ⚠️ **The unshielded feed is blind to them.** A shielded transfer has no unshielded output of ours, so
 * it never appears in `rows` and the ordinary rule called every one of them abandoned once its window
 * passed — false whenever it landed. The identifiers were recorded at submission and the indexer
 * resolves them (`identifier-lookup.ts`), so the outcome is one small query per send.
 *
 * ⚠️ **A failed lookup is not an absence.** Those land in `unanswered` and keep the send pending: an
 * unreachable indexer must not be able to declare a send that is fine to be lost.
 */
const askChainAboutShielded = (
  sends: readonly PendingSend[],
  network: string | null,
): Effect.Effect<ShieldedVerdicts> =>
  Effect.gen(function* () {
    const landed: {send: PendingSend; found: IdentifiedTransaction}[] = []
    const unanswered = new Set<string>()
    for (const send of sends) {
      if (send.rail !== 'shielded') continue
      let seen: IdentifiedTransaction | null = null
      let failed = false
      for (const identifier of send.identifiers) {
        const answer = yield* Effect.either(lookupByIdentifier(network, identifier))
        if (answer._tag === 'Left') {
          logger.warn('could not ask the chain about a shielded send', {
            origin: ORIGIN,
            cause: answer.left.cause,
            error: answer.left.reason,
          })
          failed = true
          continue
        }
        if (answer.right !== null) {
          seen = answer.right
          break
        }
      }
      if (seen !== null) landed.push({send, found: seen})
      else if (failed) unanswered.add(sendKey(send))
    }
    return {landed, unanswered}
  })

/**
 * Settle this wallet's **shielded** pending sends against the chain, with no feed involved.
 *
 * ⚠️ **Without this the shielded half never runs.** {@link settlePendingSends} is reached from the
 * unshielded feed, and that feed only settles when an unshielded transaction actually arrives — which a
 * shielded transfer never produces. Measured on device 2026-09-14: a shielded send that had landed sat
 * pending indefinitely because nothing called the settler. This is the call the shielded sync makes.
 *
 * ⚠️ **It never abandons.** Absence here is not evidence: the window rule belongs to
 * {@link settlePendingSends}, which has the unshielded rows to judge against. This one only promotes
 * what the chain confirms. A shielded send is sponsor-paid, so there is no pending DUST spend of ours
 * to promote either.
 */
export const settleShieldedSends = (
  groupId: string,
  accountIndex: number,
  network: string | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* settlementStep(() => loadPendingSends(groupId, accountIndex))
    const shielded = pending.filter((send) => send.rail === 'shielded')
    if (shielded.length === 0) return
    const {landed} = yield* askChainAboutShielded(shielded, network)
    if (landed.length === 0) {
      logger.debug('no shielded pending send has appeared on chain yet', {
        origin: ORIGIN,
        groupId,
        pending: shielded.length,
      })
      return
    }
    for (const {send, found} of landed) {
      logger.info('a pending shielded send landed', {
        origin: ORIGIN,
        groupId,
        rail: send.rail,
        hash: found.hash,
        blockHeight: found.blockHeight,
        status: found.status ?? 'unreported',
        failedSegments: found.failedSegments,
      })
    }
    const settled = landed.map(({send}) => send.identifiers)
    yield* releaseUnshieldedLocks(groupId, accountIndex, settled)
    yield* settlementStep(() => removePendingSends(groupId, accountIndex, settled))
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.warn('could not settle this wallet’s shielded sends', {origin: ORIGIN, groupId, error: error.reason})
      }),
    ),
  )

export const settlePendingSends = (
  groupId: string,
  accountIndex: number,
  rows: readonly MidnightActivity[],
  network: string | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* settlementStep(() => loadPendingSends(groupId, accountIndex))
    if (pending.length === 0) return
    const {resolved, stillPending, abandoned} = resolvePendingSends(pending, rows, Date.now())
    // Shielded sends are invisible to this feed, so the chain is asked about them directly — both the
    // ones still inside their window and the ones past it, because "past its window" is exactly the
    // case the old rule got wrong.
    const shielded = yield* askChainAboutShielded([...stillPending, ...abandoned], network)
    // Landed on chain, or unanswerable right now: neither may be abandoned.
    const settledElsewhere = new Set([...shielded.landed.map(({send}) => sendKey(send)), ...shielded.unanswered])
    const lost = abandoned.filter((send) => !settledElsewhere.has(sendKey(send)))

    for (const {send, row} of resolved) {
      // `outcome` absent means the indexer reported no result for the transaction, which is not the
      // same as a success — so it is logged as unknown rather than defaulted.
      logger.info('a pending send landed', {
        origin: ORIGIN,
        groupId,
        rail: send.rail,
        hash: row.hash,
        status: row.outcome?.status ?? 'unreported',
        failedSegments: (row.outcome?.segments ?? []).filter((s) => !s.success).map((s) => s.id),
      })
    }
    for (const {send, found} of shielded.landed) {
      logger.info('a pending shielded send landed', {
        origin: ORIGIN,
        groupId,
        rail: send.rail,
        hash: found.hash,
        blockHeight: found.blockHeight,
        status: found.status ?? 'unreported',
        failedSegments: found.failedSegments,
      })
    }
    for (const send of lost) {
      logger.warn('a pending send never appeared on chain and is past its window', {
        origin: ORIGIN,
        groupId,
        rail: send.rail,
        submittedAt: send.submittedAt,
      })
    }

    // A self-funded send's DUST spend is held pending against the same identifiers, and this is the
    // only place the chain's verdict is ever learned. Landing promotes it; abandonment discards it and
    // the DUST comes back. Doing nothing here would leave the pending spend to expire on its TTL, which
    // is correct but slower, and after a *successful* send would then wrongly restore a spent output.
    for (const {send} of resolved) {
      if (yield* pendingDustSpendMatches(groupId, accountIndex, send.identifiers)) {
        yield* promotePendingDustSpend(groupId, accountIndex)
      }
    }
    for (const {send} of shielded.landed) {
      if (yield* pendingDustSpendMatches(groupId, accountIndex, send.identifiers)) {
        yield* promotePendingDustSpend(groupId, accountIndex)
      }
    }
    for (const send of lost) {
      if (yield* pendingDustSpendMatches(groupId, accountIndex, send.identifiers)) {
        logger.warn('the send holding a pending dust spend never appeared; giving the DUST back', {
          origin: ORIGIN,
          groupId,
        })
        yield* discardPendingDustSpend(groupId, accountIndex)
      }
    }

    // Landed or abandoned, the transaction can no longer take those inputs — a landing consumed them
    // and the chain now says so, an abandonment means it never will.
    const settled = [
      ...resolved.map(({send}) => send.identifiers),
      ...shielded.landed.map(({send}) => send.identifiers),
      ...lost.map((send) => send.identifiers),
    ]
    if (settled.length > 0) yield* releaseUnshieldedLocks(groupId, accountIndex, settled)

    // ⚠️ **Remove what settled; never write back "the rest".** A blind replace drops a send recorded
    // between this function's read and its write — and since the live feed settles on every
    // transaction it sees, that window is open continuously rather than once per manual sync. The
    // dropped send would be invisible on screen, its locks held to their TTL and its DUST spend never
    // promoted. `stillPending` is therefore only used for the decision, not as the value to store.
    if (settled.length > 0) {
      yield* settlementStep(() => removePendingSends(groupId, accountIndex, settled))
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.warn('could not settle pending sends after a sync', {origin: ORIGIN, groupId, error: error.reason})
      }),
    ),
  )
