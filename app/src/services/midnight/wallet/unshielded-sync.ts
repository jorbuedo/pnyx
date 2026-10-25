/**
 * Read an address's unshielded UTxO set from the indexer.
 *
 * The subscription replays every transaction that ever touched the address, oldest first, and then stays
 * open for live ones. So a "sync" here is: subscribe from a transaction-id cursor, fold the replay, and
 * stop once the replay has caught up — at which point the socket is closed rather than held. A wallet
 * screen wants a set and a cursor, not a live connection it has to own.
 *
 * ⚠️ **`UnshieldedTransactionsProgress` is the catch-up signal, and it arrives first.** The indexer sends
 * progress with `highestTransactionId` before (and between) transaction events. Reading it as "we are
 * done" on arrival would end the sync before any transaction was folded, so the walk stops on progress
 * only once the transactions it has seen have reached that id — or immediately, when the highest id is
 * zero and there is nothing to replay.
 *
 * @module
 */

import {Data, Effect} from 'effect'
import {indexerWebsocketUrl} from '../../../config/chain-endpoints'
import {logger} from '../../../logger'
import {midnightIndexerUrlFor} from '../contract-state'
import {authorizeIndexerWsUrl} from '../indexer-auth'
import {runSubscription, type SocketFactory} from './graphql-ws'
import type {MidnightActivity} from './midnight-activity'
import {
  emptyFold,
  foldedActivity,
  foldIsCaughtUp,
  foldShouldStop,
  foldUnshieldedFrame,
  type UnshieldedFrame,
} from './unshielded-fold'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ORIGIN = 'unshielded-sync'

/**
 * The address could not be read.
 *
 * ⚠️ `cause` separates the two, because only one of them is worth retrying. `not-configured` means this
 * build has no indexer for the network and never will until the environment changes — the state behind
 * Q5 in `docs/FOLLOW_UPS.md`, which today reaches the user as an indistinguishable "unavailable".
 * `transport` means the socket failed, which the next sync may well survive.
 */
export class UnshieldedSyncError extends Data.TaggedError('UnshieldedSyncError')<{
  readonly cause: 'not-configured' | 'transport'
  readonly reason: string
}> {}

/**
 * `transaction { id }` is the cursor the subscription itself takes, so it is what a resume stores —
 * block heights do not address this stream.
 *
 * Exported because the live feed (`./unshielded-live.ts`) reads the same subscription. One query, so
 * the two readers cannot ask for different fields and disagree about what a transaction contains.
 */
export const UNSHIELDED_SUBSCRIPTION = `subscription Unshielded($address: UnshieldedAddress!, $transactionId: Int) {
  unshieldedTransactions(address: $address, transactionId: $transactionId) {
    __typename
    ... on UnshieldedTransactionsProgress {
      highestTransactionId
    }
    ... on UnshieldedTransaction {
      transaction {
        id
        hash
        ... on RegularTransaction {
          fee
          block { height timestamp }
          identifiers
          transactionResult { status segments { id success } }
        }
      }
      createdUtxos {
        owner
        tokenType
        value
        intentHash
        outputIndex
        ctime
        registeredForDustGeneration
        createdAtTransaction { hash }
      }
      spentUtxos { owner tokenType value intentHash outputIndex }
    }
  }
}`

type Payload = {readonly unshieldedTransactions?: UnshieldedFrame | null}

/**
 * The HTTP indexer URL turned into its WebSocket sibling. The indexer serves the socket at `/ws`.
 *
 * ⚠️ **Not string concatenation**, which is what this was until 2026-10-13: `/ws` has to go on the
 * *path*, and appending it to a URL carrying a `?project_id=` credential produced
 * `…/graphql?project_id=KEY/ws` — a URL the server refuses, and the exact form
 * `indexerWebsocketUrl` was written to avoid. Every dust and unshielded subscription went through
 * here, so the lesson was learnt in one module and not applied in this one.
 *
 * The credential is appended **here and only here**: a browser `WebSocket` cannot set a header, so
 * the handshake is the one place the key must ride in a URL (`../indexer-auth.ts`).
 */
export const indexerWsUrl = (httpUrl: string): string => authorizeIndexerWsUrl(indexerWebsocketUrl(httpUrl))

export type UnshieldedSyncResult = {
  readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
  /** Every transaction the replay carried, oldest first — the activity list's source. */
  readonly activity: readonly MidnightActivity[]
  /** The highest transaction id the indexer reported, for a later resume. `null` when it said nothing. */
  readonly highestTransactionId: number | null
  readonly transactionsApplied: number
  /** True when the replay reached the id the indexer named as highest. */
  readonly caughtUp: boolean
}

/**
 * Fold the replay for `address` into a UTxO set.
 *
 * Starts from `from` (a UTxO set and a cursor) so a resume does not re-read history the caller already
 * folded. Fails with {@link UnshieldedSyncError} when the subscription cannot be established or the
 * indexer reports an error — an empty set is a real answer and must not be produced by a failure.
 */
export const syncUnshielded = (params: {
  readonly address: string
  readonly network: string | null
  readonly from?: {
    readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
    readonly transactionId: number
  }
  readonly timeoutMs?: number
  readonly socketFactory?: SocketFactory
}): Effect.Effect<UnshieldedSyncResult, UnshieldedSyncError> =>
  Effect.gen(function* () {
    const httpUrl = midnightIndexerUrlFor(params.network)
    if (httpUrl === null) {
      return yield* new UnshieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${params.network ?? 'unset'}`,
      })
    }

    // The fold shares `./unshielded-fold.ts` with the live feed, so the two readers of this
    // subscription cannot drift. The loop stays inside one promise: `onNext` is a callback the socket
    // drives, and lifting each frame into the Effect runtime would buy nothing but a scheduler hop.
    let state = emptyFold(params.from)

    yield* Effect.tryPromise({
      try: () =>
        runSubscription<Payload>({
          url: indexerWsUrl(httpUrl),
          query: UNSHIELDED_SUBSCRIPTION,
          variables: {address: params.address, transactionId: params.from?.transactionId ?? 0},
          ...(params.timeoutMs === undefined ? {} : {timeoutMs: params.timeoutMs}),
          ...(params.socketFactory === undefined ? {} : {socketFactory: params.socketFactory}),
          onNext: (data) => {
            const frame = data.unshieldedTransactions
            if (frame === null || frame === undefined) return 'continue'
            state = foldUnshieldedFrame(state, frame, params.address)
            return foldShouldStop(state) ? 'stop' : 'continue'
          },
        }),
      catch: (error) => new UnshieldedSyncError({cause: 'transport', reason: String(error)}),
    })

    const caughtUp = foldIsCaughtUp(state)
    // Logged on the happy path too: "0 UTxOs" and "never ran" are the same on screen otherwise.
    logger.info('unshielded sync read', {
      origin: ORIGIN,
      network: params.network,
      utxos: state.utxos.size,
      applied: state.applied,
      highestTransactionId: state.highestTransactionId,
      caughtUp,
    })

    return {
      utxos: state.utxos,
      activity: foldedActivity(state),
      highestTransactionId: state.highestTransactionId,
      transactionsApplied: state.applied,
      caughtUp,
    }
  })
