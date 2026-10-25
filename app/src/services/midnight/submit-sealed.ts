/**
 * Submitting a sealed Midnight transaction straight to the chain.
 *
 * The sponsor's `/chain/submit` takes a **proven but unbound** transaction and binds its own DUST fee
 * into it. A sealed transaction — one that paid its own fee, and a DUST registration — has nothing
 * left to bind, so that route cannot carry it: the sponsor would be asked to balance a transaction
 * that is already balanced. This is the other door, and until now the app had none.
 *
 * ⚠️ **A sealed transaction does have a hash**, which is the one place the app's usual rule
 * (`services/midnight/send.ts`: a device-built transaction has no hash, only identifiers) does not
 * apply. The rule holds for unbound transactions because binding rewrites the bytes at the sponsor,
 * so nothing the device could hash survives. Sealed bytes are final, so the extrinsic hash the node
 * returns is a stable handle — it is the hash of the *extrinsic*, not of the Midnight transaction, and
 * naming it as such is the difference between a handle and a wrong answer.
 *
 * ⚠️ **Acceptance is not inclusion.** `author_submitExtrinsic` answers as soon as the node takes the
 * extrinsic into its pool, so what comes back means "well-formed and worth gossiping", not "on chain".
 * Watching for inclusion needs `author_submitAndWatchExtrinsic`, which is a subscription and therefore
 * a WebSocket; over HTTP the honest report is that it was submitted, and the caller's own state — a
 * DUST balance, a UTxO — is what confirms it landed.
 *
 * @module
 */

import {Data, Effect} from 'effect'

import {logger} from '../../logger'
import {nameLedgerRejection} from './ledger-error-codes'
import {midnightNodeWsFor} from './networks'
import {assertCallEncodingSupported, encodeSendMnTransaction, type SubstrateRuntimeVersion} from './substrate-extrinsic'

const ORIGIN = 'midnight-submit-sealed'

/**
 * Why a submit did not land.
 *
 * ⚠️ **`rejected` versus `unreachable` is a money-safety distinction, not a tidiness one.** A JSON-RPC
 * rejection is **definitive**: the node received the bytes, refused them, and nothing is in flight — so
 * a caller on `prefer-self` may safely fall back to the sponsor. A timeout or a dropped socket says
 * nothing about whether the transaction was taken, and falling back on one of those could send the same
 * money twice. `not-configured` is this build having no node for the network, which no retry fixes.
 *
 * This replaces a hand-rolled `NodeRejectedError extends Error` and an `isNodeRejection(error: unknown)`
 * helper — the pair `docs/EFFECT_MIGRATION.md` names as the reason to migrate. The helper had **no
 * callers**, so the fallback decision it existed for was declared and never made. `Effect.catchTag` is
 * how it gets made.
 */
export class SubmitSealedError extends Data.TaggedError('SubmitSealedError')<{
  readonly cause: 'rejected' | 'unreachable' | 'not-configured' | 'malformed'
  readonly reason: string
}> {}

export type SubmitSealedParams = {
  /** The sealed transaction, exactly as the native builder produced it. */
  readonly transaction: Uint8Array
  /** The Midnight **funds** network, e.g. `preprod` — see {@link midnightFundsNetwork}. */
  readonly network: string
}

export type SubmitSealedResult = {
  /** blake2-256 of the submitted extrinsic, `0x`-prefixed, as the node returned it. */
  readonly extrinsicHash: string
  /** Bytes of the extrinsic, i.e. the transaction plus its substrate framing. */
  readonly extrinsicBytes: number
}

type JsonRpcResponse<T> = {
  readonly result?: T
  readonly error?: {readonly code: number; readonly message: string; readonly data?: unknown}
}

/** How long a socket has to open, answer, and be done with it. */
const SOCKET_TIMEOUT_MS = 30_000

/**
 * A JSON-RPC conversation over one WebSocket to the node.
 *
 * ⚠️ **WebSocket rather than HTTP, and this is not a preference.** The public RPC's HTTP front end
 * refuses a request body over 8 KiB with a bare nginx `403 Forbidden` — see {@link midnightNodeWsFor}
 * for the measurement. Since a transaction travels as hex inside JSON, that cap sits at roughly 4 KB of
 * transaction, which no contract call fits under. The refusal names nothing about the transaction, so
 * it reads as a permissions failure rather than a size one, and it cost a session to identify.
 *
 * One socket for the whole exchange, so the runtime check doubles as proof the connection works before
 * the large payload goes out. Every request carries its own id and answers are matched by it, because
 * substrate is free to interleave.
 *
 * Failures map onto the `cause` distinction the module doc draws: anything the node *said* is
 * `rejected` and definitive, while a socket that never opened, timed out, or closed early is
 * `unreachable` and says nothing about whether the bytes were taken.
 */
const withNodeSocket = <T>(
  url: string,
  body: (
    call: <R>(method: string, params: readonly unknown[]) => Effect.Effect<R, SubmitSealedError>,
  ) => Effect.Effect<T, SubmitSealedError>,
): Effect.Effect<T, SubmitSealedError> =>
  Effect.acquireUseRelease(
    Effect.async<WebSocket, SubmitSealedError>((resume) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        resume(
          Effect.fail(
            new SubmitSealedError({
              cause: 'unreachable',
              reason: `the node at ${url} did not accept a socket within ${SOCKET_TIMEOUT_MS} ms`,
            }),
          ),
        )
      }, SOCKET_TIMEOUT_MS)
      socket.onopen = () => {
        clearTimeout(timer)
        resume(Effect.succeed(socket))
      }
      socket.onerror = (event) => {
        clearTimeout(timer)
        // RN's error event carries no cause worth quoting, so the URL is the diagnosis: a wrong scheme
        // and an unreachable host look identical here and are told apart by which one it names.
        resume(
          Effect.fail(
            new SubmitSealedError({
              cause: 'unreachable',
              reason: `could not open a socket to ${url}: ${JSON.stringify((event as unknown as {message?: string}).message ?? 'no detail')}`,
            }),
          ),
        )
      }
    }),
    (socket) => {
      let nextId = 1
      const call = <R>(method: string, params: readonly unknown[]): Effect.Effect<R, SubmitSealedError> =>
        Effect.async<R, SubmitSealedError>((resume) => {
          const id = nextId++
          const timer = setTimeout(() => {
            socket.onmessage = null
            resume(
              Effect.fail(
                new SubmitSealedError({
                  cause: 'unreachable',
                  reason: `${method} did not answer within ${SOCKET_TIMEOUT_MS} ms`,
                }),
              ),
            )
          }, SOCKET_TIMEOUT_MS)
          const finish = (outcome: Effect.Effect<R, SubmitSealedError>) => {
            clearTimeout(timer)
            socket.onmessage = null
            socket.onclose = null
            resume(outcome)
          }
          socket.onclose = () =>
            // A close before the answer is not a rejection: the node may have taken the bytes and gone
            // away, and treating it as refusal is what would let a caller send the same thing twice.
            finish(
              Effect.fail(
                new SubmitSealedError({cause: 'unreachable', reason: `the socket closed before ${method} answered`}),
              ),
            )
          socket.onmessage = (event: {data: unknown}) => {
            let payload: JsonRpcResponse<R> & {id?: number}
            try {
              payload = JSON.parse(String(event.data)) as JsonRpcResponse<R> & {id?: number}
            } catch (error) {
              finish(
                Effect.fail(
                  new SubmitSealedError({
                    cause: 'malformed',
                    reason: `${method} answered with something that is not JSON: ${String(error)}`,
                  }),
                ),
              )
              return
            }
            // Not ours. Substrate may push a subscription frame or answer out of order, and consuming
            // somebody else's answer as this one's is worse than waiting for the timeout.
            if (payload.id !== id) return
            if (payload.error !== undefined) {
              // `data` is where substrate puts the reason: `message` is the generic "Invalid Transaction"
              // for every rejection alike, and the `Custom error: N` that names which ledger rule was
              // broken only ever appears here. Dropping it turns every distinct failure into the same
              // unactionable line.
              const detail = payload.error.data === undefined ? '' : ` (${JSON.stringify(payload.error.data)})`
              finish(
                Effect.fail(
                  new SubmitSealedError({
                    cause: 'rejected',
                    reason: nameLedgerRejection(
                      `${method} was rejected: ${payload.error.code} ${payload.error.message}${detail}`,
                    ),
                  }),
                ),
              )
              return
            }
            if (payload.result === undefined) {
              finish(
                Effect.fail(
                  new SubmitSealedError({
                    cause: 'malformed',
                    reason: `${method} answered with neither a result nor an error`,
                  }),
                ),
              )
              return
            }
            finish(Effect.succeed(payload.result))
          }
          socket.send(JSON.stringify({jsonrpc: '2.0', id, method, params}))
        })
      return body(call)
    },
    (socket) =>
      Effect.sync(() => {
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
        socket.close()
      }),
  )

/**
 * Submit a sealed transaction, refusing first if the node's runtime is not the one we encode for.
 *
 * The runtime check is a separate round trip on purpose. It costs one small request and it is the
 * only thing standing between a pallet renumbering and this app handing a Midnight transaction to
 * some other pallet's call — see {@link MIDNIGHT_CALL_ENCODING}.
 */
export const submitSealedTransaction = (
  params: SubmitSealedParams,
): Effect.Effect<SubmitSealedResult, SubmitSealedError> =>
  Effect.gen(function* () {
    const url = midnightNodeWsFor(params.network)
    if (url === null) {
      return yield* new SubmitSealedError({
        cause: 'not-configured',
        reason: `no Midnight node socket for network '${params.network}'`,
      })
    }

    const extrinsic = yield* Effect.try({
      try: () => encodeSendMnTransaction(params.transaction),
      catch: (error) => new SubmitSealedError({cause: 'malformed', reason: String(error)}),
    })
    const hexExtrinsic = `0x${Array.from(extrinsic, (b) => b.toString(16).padStart(2, '0')).join('')}`

    return yield* withNodeSocket(url, (call) =>
      Effect.gen(function* () {
        const runtime = yield* call<SubstrateRuntimeVersion>('state_getRuntimeVersion', [])
        // Still a throw: a runtime mismatch is a programming-time fact about this build, not a chain
        // answer, and it is shared with the pure SCALE encoders that have no Effect context.
        yield* Effect.try({
          try: () => assertCallEncodingSupported(runtime),
          catch: (error) => new SubmitSealedError({cause: 'not-configured', reason: String(error)}),
        })

        logger.info('submitting a sealed Midnight transaction to the node', {
          origin: ORIGIN,
          network: params.network,
          txBytes: params.transaction.length,
          extrinsicBytes: extrinsic.length,
        })

        const extrinsicHash = yield* call<string>('author_submitExtrinsic', [hexExtrinsic])

        logger.info('the node took a sealed Midnight transaction into its pool', {
          origin: ORIGIN,
          network: params.network,
          extrinsicHash,
        })
        return {extrinsicHash, extrinsicBytes: extrinsic.length}
      }),
    )
  })
