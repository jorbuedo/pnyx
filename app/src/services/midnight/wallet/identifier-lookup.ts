/**
 * Asking the chain what became of a transaction the device built, by identifier.
 *
 * ⚠️ **This exists because a shielded send could never learn it landed.** A send's outcome is settled
 * by recognising it in the unshielded feed (`settle-pending-sends.ts`), and a shielded transfer has no
 * unshielded output of ours to appear in — so every shielded send waited out its window and was logged
 * *"never appeared on chain"*, which is false whenever it landed.
 *
 * The indexer can answer directly: `transactions(offset: {identifier})` resolves a device identifier —
 * the one thing a device-built transaction has, since binding happens at the sponsor and only a bound
 * transaction has a hash — to the transaction that carried it. Verified against preprod on 2026-09-14:
 * identifier `00a7ce0c…cf70` resolves to `6b5e8832…dce4` in block 2,534,136, `SUCCESS`.
 *
 * One small HTTP request per identifier. That is well inside the indexer's limits, which bite on
 * backfills rather than on single reads — see `block-query.ts` for the three of them.
 *
 * @module
 */

import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {midnightIndexerUrlFor} from '../contract-state'

const ORIGIN = 'midnight-identifier'

export class IdentifierLookupError extends Data.TaggedError('IdentifierLookupError')<{
  readonly cause: 'not-configured' | 'http' | 'graphql'
  readonly reason: string
}> {}

/** A transaction the chain has, as the identifier lookup reports it. */
export type IdentifiedTransaction = {
  readonly hash: string
  readonly blockHeight: number
  /**
   * The indexer's own verdict, or `null` when it reported none.
   *
   * `null` is not a success. A transaction can be indexed before its result is, and defaulting the
   * absence to `SUCCESS` would tell a user their money moved on the strength of a missing field.
   */
  readonly status: string | null
  readonly failedSegments: readonly number[]
}

const QUERY = `query ByIdentifier($id: HexEncoded!) {
  transactions(offset: {identifier: $id}) {
    hash
    block { height }
    ... on RegularTransaction {
      transactionResult { status segments { id success } }
    }
  }
}`

type Reply = {
  readonly data?: {
    readonly transactions?: readonly {
      readonly hash?: string
      readonly block?: {readonly height?: number}
      readonly transactionResult?: {
        readonly status?: string
        readonly segments?: readonly {readonly id: number; readonly success: boolean}[] | null
      } | null
    }[]
  }
  readonly errors?: readonly {readonly message: string}[]
}

/**
 * What the chain holds for one identifier, or `null` when it holds nothing.
 *
 * ⚠️ `null` means *the indexer answered and knows of no such transaction* — it is the evidence a send
 * is still in flight. A read that failed is a typed failure instead, because the two must not settle
 * the same way: an unreachable indexer that answered `null` would abandon sends that are fine.
 */
export const lookupByIdentifier = (
  network: string | null,
  identifier: string,
): Effect.Effect<IdentifiedTransaction | null, IdentifierLookupError> =>
  Effect.gen(function* () {
    const url = midnightIndexerUrlFor(network)
    if (url === null) {
      return yield* new IdentifierLookupError({
        cause: 'not-configured',
        reason: `no indexer configured for ${network ?? 'an unnamed network'}`,
      })
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({query: QUERY, variables: {id: identifier}}),
        }),
      catch: (error) => new IdentifierLookupError({cause: 'http', reason: String(error)}),
    })
    if (!response.ok) {
      return yield* new IdentifierLookupError({cause: 'http', reason: `indexer responded ${response.status}`})
    }
    const reply = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Reply>,
      catch: (error) => new IdentifierLookupError({cause: 'http', reason: String(error)}),
    })
    // ⚠️ A GraphQL error arrives with HTTP 200 and `data: null`. Read as an empty list it would say
    // "this transaction does not exist", which is how a send that landed gets called abandoned.
    if (reply.errors !== undefined && reply.errors.length > 0) {
      return yield* new IdentifierLookupError({
        cause: 'graphql',
        reason: reply.errors.map((error) => error.message).join('; '),
      })
    }
    const found = reply.data?.transactions?.[0]
    if (found === undefined) return null
    const {hash, block} = found
    if (hash === undefined || block?.height === undefined) {
      // The indexer named a transaction without the two fields that identify it. Nothing here can be
      // acted on, and treating it as "found" would settle a send against a row it cannot describe.
      logger.warn('the indexer resolved an identifier to a transaction with no hash or height', {
        origin: ORIGIN,
        identifier,
      })
      return null
    }
    return {
      hash,
      blockHeight: block.height,
      status: found.transactionResult?.status ?? null,
      failedSegments: (found.transactionResult?.segments ?? []).filter((s) => !s.success).map((s) => s.id),
    }
  })
