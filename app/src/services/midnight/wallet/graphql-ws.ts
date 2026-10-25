/**
 * The `graphql-transport-ws` half of the indexer client, hand-rolled over the platform WebSocket.
 *
 * ⚠️ **A subscription is the only way to read unshielded UTxOs.** The indexer's `Query` type has no
 * by-address field — `block`, `transactions`, `contractAction`, the DUST and SPO reads, and nothing
 * else — while `Subscription` has `unshieldedTransactions(address, transactionId)`. So an unshielded
 * balance is not a fetch we are choosing to make a stream; there is no fetch.
 *
 * Hand-rolled rather than `graphql-ws`: that package is present in `node_modules` only as a transitive
 * dependency of the Midnight SDK, and depending on a package we do not declare is how a lockfile bump
 * silently removes a rail. The protocol we need is four messages (`connection_init`, `connection_ack`,
 * `subscribe`, `next`/`complete`), it is stable, and this way the client runs on Hermes with nothing to
 * polyfill.
 *
 * ⚠️ **A GraphQL error arrives inside `next`, not as an `error` frame.** Subscribing with a malformed
 * address returns `{type: 'next', payload: {data: null, errors: [...]}}` and then `complete` — verified
 * against the preprod indexer. A client that only watched for `type: 'error'` would report that as a
 * successful subscription that produced no UTxOs, which is the difference between "this address holds
 * nothing" and "we never asked about it".
 *
 * @module
 */

import {Effect, Stream} from 'effect'

import {logger} from '../../../logger'

const ORIGIN = 'graphql-ws'

/** The subprotocol the indexer negotiates. Sent as the WebSocket protocol, not as a header. */
export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws'

export type SocketEvents = {
  readonly onOpen: () => void
  readonly onMessage: (data: string) => void
  readonly onError: (error: unknown) => void
  readonly onClose: (info: {readonly code?: number; readonly reason?: string}) => void
}

export type Socket = {
  readonly send: (data: string) => void
  readonly close: () => void
}

/**
 * How a socket is obtained. Injected so the driver is testable without a network: the default is the
 * platform `WebSocket`, which exists on React Native, browsers and Node 22+.
 */
export type SocketFactory = (url: string, protocol: string, events: SocketEvents) => Socket

export const platformSocketFactory: SocketFactory = (url, protocol, events) => {
  const ws = new WebSocket(url, protocol)
  ws.addEventListener('open', () => events.onOpen())
  ws.addEventListener('message', (event) => {
    const {data} = event as MessageEvent
    if (typeof data === 'string') events.onMessage(data)
    else events.onError(new Error(`unexpected non-string frame (${typeof data})`))
  })
  ws.addEventListener('error', (event) => events.onError(event))
  ws.addEventListener('close', (event) => {
    const {code, reason} = event as CloseEvent
    events.onClose({code, reason})
  })
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  }
}

/** What {@link runSubscription}'s handler says about a payload it has just been given. */
export type Verdict = 'continue' | 'stop'

export class SubscriptionError extends Error {}

/**
 * A readable description of whatever a socket hands to `onError`.
 *
 * ⚠️ **`String(error)` is useless here.** React Native passes an `Event`-shaped object, so the default
 * renders `[object Object]` — the one path that carries the cause of a failed connection, reporting
 * nothing. That cost a debugging session: a DUST sync failed with `socket error: [object Object]` and
 * there was no way to tell a refused TLS handshake from a rejected subprotocol.
 */
export const describeSocketError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const row = error as {message?: unknown; reason?: unknown; code?: unknown; type?: unknown}
    const parts = [row.message, row.reason, row.code, row.type]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(String)
    if (parts.length > 0) return parts.join(' · ')
    try {
      // Own properties only: an Event's interesting fields are not enumerable.
      const own = JSON.stringify(error, Object.getOwnPropertyNames(error))
      return own === '{}' ? 'an error object with no readable fields' : own.slice(0, 200)
    } catch (e: unknown) {
      // This function exists to describe an error, so failing here loses the original entirely.
      logger.debug('Socket error object could not be serialised', {
        origin: 'midnight/graphql-ws',
        error: String(e),
      })
      return 'an unserializable error object'
    }
  }
  return String(error)
}

/**
 * Open one subscription, hand every `next` payload to `onNext`, and resolve when the handler says
 * `'stop'`, the server sends `complete`, or `timeoutMs` elapses.
 *
 * Resolving on timeout rather than throwing is deliberate: `unshieldedTransactions` replays history and
 * then stays open for live events, so "no more messages" is its steady state, not a fault. A caller that
 * has read the replay it wanted stops from `onNext`; the timeout only bounds the case where the server
 * says nothing at all.
 *
 * Rejects — never resolves quietly — when the server reports a GraphQL error, when the socket errors, or
 * when it closes before the first payload. Each of those would otherwise be indistinguishable from an
 * address that holds nothing.
 */
export const runSubscription = async <T>(params: {
  readonly url: string
  readonly query: string
  readonly variables: Readonly<Record<string, unknown>>
  readonly onNext: (data: T) => Verdict
  /**
   * Silence after which the subscription resolves. `null` disables it — for a caller that means to
   * hold the socket open indefinitely, where silence is the steady state rather than a bound worth
   * enforcing. A number is still the default for a caller reading a replay and leaving.
   */
  readonly timeoutMs?: number | null
  readonly socketFactory?: SocketFactory
  /**
   * Handed a function that ends the subscription and closes the socket, once, during setup.
   *
   * ⚠️ Deliberately not an `AbortSignal`: nothing in this app uses one, so it would be the first bet
   * on that API being present under Hermes. A callback is the same mechanism without the bet.
   */
  readonly onCancel?: (cancel: () => void) => void
}): Promise<void> => {
  const factory = params.socketFactory ?? platformSocketFactory
  const timeoutMs = params.timeoutMs === undefined ? 30_000 : params.timeoutMs
  const id = '1'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let acked = false
    let payloads = 0
    let socket: Socket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        socket?.close()
      } catch (closeError) {
        // Closing a socket that is already gone is not a failure of the subscription, but a close that
        // throws for any other reason would otherwise leave no trace at all.
        logger.debug('closing the subscription socket threw', {origin: ORIGIN, error: String(closeError)})
      }
      if (error === undefined) resolve()
      else reject(error)
    }

    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        logger.debug('subscription timed out', {origin: ORIGIN, timeoutMs, payloads})
        finish()
      }, timeoutMs)
    }

    // Before the socket exists, so a cancel that arrives during setup still settles the promise rather
    // than racing the factory.
    params.onCancel?.(() => {
      finish()
    })

    const handle = (raw: string): void => {
      let message: {type?: unknown; payload?: unknown}
      try {
        message = JSON.parse(raw) as {type?: unknown; payload?: unknown}
      } catch (error) {
        finish(new SubscriptionError(`unparseable frame: ${String(error)}`))
        return
      }
      switch (message.type) {
        case 'connection_ack': {
          acked = true
          socket?.send(
            JSON.stringify({id, type: 'subscribe', payload: {query: params.query, variables: params.variables}}),
          )
          return
        }
        // The server may ping to keep the connection alive; an unanswered ping ends the socket.
        case 'ping': {
          socket?.send(JSON.stringify({type: 'pong'}))
          return
        }
        case 'pong':
          return
        case 'next': {
          const payload = message.payload as {data?: T; errors?: readonly {message?: string}[]} | undefined
          const errors = payload?.errors
          if (errors !== undefined && errors.length > 0) {
            finish(new SubscriptionError(errors.map((e) => e.message ?? 'unknown error').join('; ')))
            return
          }
          if (payload?.data === undefined || payload.data === null) {
            finish(new SubscriptionError('a next frame carried neither data nor errors'))
            return
          }
          payloads += 1
          if (params.onNext(payload.data) === 'stop') finish()
          return
        }
        case 'error': {
          const errors = message.payload as readonly {message?: string}[] | undefined
          const detail = (errors ?? []).map((e) => e.message ?? 'unknown error').join('; ')
          finish(new SubscriptionError(detail === '' ? 'subscription error' : detail))
          return
        }
        case 'complete': {
          finish()
          return
        }
        default: {
          // An unknown frame is the server speaking a protocol version we do not: log it and keep going,
          // because dropping it silently would make a future handshake change look like a dead socket.
          logger.debug('ignoring an unknown frame', {origin: ORIGIN, frameType: String(message.type)})
        }
      }
    }

    socket = factory(params.url, GRAPHQL_TRANSPORT_WS, {
      onOpen: () => socket?.send(JSON.stringify({type: 'connection_init'})),
      onMessage: handle,
      onError: (error) => finish(new SubscriptionError(`socket error: ${describeSocketError(error)}`)),
      onClose: (info) => {
        if (payloads > 0) {
          finish()
          return
        }
        finish(
          new SubscriptionError(
            `socket closed before any payload (acked=${acked}, code=${info.code ?? 'none'}, reason=${
              info.reason === undefined || info.reason === '' ? 'none' : info.reason
            })`,
          ),
        )
      },
    })
  })
}

/**
 * The same subscription as a `Stream`, held open until the consumer stops reading.
 *
 * ⚠️ **This is the shape the unshielded rail actually has.** The indexer's `Query` type has no
 * by-address field for unshielded UTxOs (see this module's header), so a balance is not a fetch anyone
 * chose to model as a stream — *there is no fetch*. {@link runSubscription} folds that live feed into a
 * promise and closes the socket at catch-up, which is why every surface then has to be told to re-read.
 * A `Stream` keeps the feed, and the socket, for as long as something is listening.
 *
 * Interrupting the consumer runs the release and closes the socket, so a screen going away takes its
 * subscription with it. `timeoutMs` defaults to **off** here, because silence on a live feed is the
 * steady state; pass one only to bound a read that expects to finish.
 */
export const subscriptionStream = <T>(params: {
  readonly url: string
  readonly query: string
  readonly variables: Readonly<Record<string, unknown>>
  readonly timeoutMs?: number | null
  readonly socketFactory?: SocketFactory
}): Stream.Stream<T, SubscriptionError> =>
  Stream.asyncPush<T, SubscriptionError>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // Assigned before `runSubscription` can call `onCancel`, which it does synchronously.
        let cancel: () => void = () => undefined
        void runSubscription<T>({
          url: params.url,
          query: params.query,
          variables: params.variables,
          timeoutMs: params.timeoutMs === undefined ? null : params.timeoutMs,
          ...(params.socketFactory === undefined ? {} : {socketFactory: params.socketFactory}),
          onCancel: (stop) => {
            cancel = stop
          },
          onNext: (data) => {
            emit.single(data)
            return 'continue'
          },
        })
          .then(() => {
            emit.end()
          })
          .catch((error: unknown) => {
            emit.fail(error instanceof SubscriptionError ? error : new SubscriptionError(String(error)))
          })
        return {cancel: () => cancel()}
      }),
      // Runs on interruption as well as on a normal end, which is what closes the socket when the last
      // reader goes away.
      (handle) => Effect.sync(() => handle.cancel()),
    ),
  )
