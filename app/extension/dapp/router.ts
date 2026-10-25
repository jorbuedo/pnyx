/**
 * Background dApp router (Arch A).
 *
 * Owns the CIP-30 resolver bound to the app-published wallet snapshot, answering
 * read methods silently in the service worker. `enable` / `signTx` / `signData`
 * surface as sentinel errors, which the router turns into an approval broadcast
 * to the app and awaits the returned decision. Dependency-injected (snapshot
 * source, session store, broadcast, submit) so the flow is unit-testable without
 * Chrome. See `docs/EXTENSION.md`.
 *
 * The requesting origin is supplied by the *caller* as `verifiedOrigin` and
 * always overrides the one in the page's payload — a page can put any string
 * there, so trusting it would let any site borrow another origin's session.
 *
 * @module
 */

import {
  ApiErrorCode,
  createCardanoHandler,
  createResolver,
  type DappMessage,
  normalizeOrigin,
  type WalletResponse,
  type WireError,
} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import type {DappSnapshot, NavigateMessage} from './protocol'
import {contextFromSnapshot} from './read-context'
import type {SessionPort} from './session-port'

/** Details the app fetches by `requestId` to render the sign-approval screen. */
export type SignRequestDetails =
  | {readonly signType: 'tx'; readonly txHex: string; readonly partialSign: boolean; readonly origin: string}
  | {readonly signType: 'data'; readonly addressHex: string; readonly payloadHex: string; readonly origin: string}

export type SignOutcome = {
  readonly result?: unknown
  readonly error?: {readonly code: number; readonly message: string}
}

/**
 * The user's answer to a connect prompt. On approval it carries the wallet group
 * and account the grant is scoped to, plus the lifetime the user chose
 * (`null` = until revoked).
 */
export type ConnectOutcome =
  | {readonly approved: false}
  | {
      readonly approved: true
      readonly groupId: string
      readonly accountIndex: number
      readonly ttlMs: number | null
    }

export type DappRouterDeps = {
  readonly loadSnapshot: () => Effect.Effect<DappSnapshot | null>
  readonly sessions: SessionPort
  /** Deliver an approval-navigation message to the app (side panel / popup). */
  readonly broadcast: (message: NavigateMessage) => void
  /** Submit a signed tx (delegated — the worker has no rail). */
  readonly submitTx: (signedTxHex: string) => Effect.Effect<string, WireError>
  /** How long to wait for the user's decision before rejecting. Default 5 min. */
  readonly decisionTimeoutMs?: number
}

export type DappRouter = {
  /**
   * Resolve a dApp request into a CIP-30 WalletResponse. `verifiedOrigin` must
   * come from the message sender (`chrome.runtime.MessageSender`), never from
   * the payload — it replaces whatever origin the page claimed.
   */
  readonly handle: (payload: DappMessage, verifiedOrigin: string) => Promise<WalletResponse>
  /** App → router: the connect decision for an origin. */
  readonly resolveConnect: (origin: string, outcome: ConnectOutcome) => void
  /** App → router: the signing outcome for a request. */
  readonly resolveSign: (requestId: string, outcome: SignOutcome) => void
  /** App → router: fetch the pending sign request's details. */
  readonly getSignRequest: (requestId: string) => SignRequestDetails | null
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Normalize for session keying, or null when the value isn't a parseable origin
 * (`normalizeOrigin` throws). Unlike the mobile connector's `safeOrigin`, an
 * unusable origin is refused rather than passed through raw — this value is the
 * authorization key.
 */
const keyableOrigin = (value: string | undefined): string | null => {
  if (value === undefined || value === '') return null
  try {
    return normalizeOrigin(value)
  } catch {
    return null
  }
}

/** A resolver-side pending decision: a promise plus its external settler. */
const deferred = <T>(timeoutMs: number, onTimeout: T): {promise: Promise<T>; settle: (v: T) => void} => {
  let settle!: (v: T) => void
  const promise = new Promise<T>((resolve) => {
    let done = false
    const finish = (v: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => finish(onTimeout), timeoutMs)
    settle = finish
  })
  return {promise, settle}
}

export const createDappRouter = (deps: DappRouterDeps): DappRouter => {
  const timeoutMs = deps.decisionTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const context = contextFromSnapshot(deps.loadSnapshot, deps.submitTx)

  /**
   * A grant only counts for the wallet group *and account* the published snapshot
   * describes. With no snapshot no read can be served anyway (each fails typed),
   * so the check loosens to "any" there — otherwise an unsynced wallet would raise
   * a spurious approval prompt instead of the accurate data error.
   */
  const isConnected = (origin: string): Effect.Effect<boolean> =>
    Effect.flatMap(deps.loadSnapshot(), (snapshot) =>
      deps.sessions.isConnected(origin, snapshot?.groupId, snapshot?.accountIndex),
    )

  const handler = createCardanoHandler(context, isConnected)
  const resolver = createResolver({handlers: new Map([['cardano', handler]])})

  const pendingConnects = new Map<string, (outcome: ConnectOutcome) => void>()
  const pendingSigns = new Map<string, (outcome: SignOutcome) => void>()
  const signRequests = new Map<string, SignRequestDetails>()

  const onConnectRequired = (payload: DappMessage, origin: string): Effect.Effect<WalletResponse> =>
    Effect.gen(function* () {
      const d = deferred<ConnectOutcome>(timeoutMs, {approved: false})
      pendingConnects.set(origin, d.settle)
      deps.broadcast({type: 'NAVIGATE_CONNECT_DAPP', origin})
      const outcome = yield* Effect.promise(() => d.promise.finally(() => pendingConnects.delete(origin)))
      if (!outcome.approved) {
        return {id: payload.id, error: {code: ApiErrorCode.Refused, message: 'connection refused'}}
      }
      yield* deps.sessions.connect(origin, outcome.groupId, outcome.accountIndex, outcome.ttlMs)
      // Confirm the grant landed: the port fails closed, so reporting success on
      // an unpersisted session would resolve enable() and then re-prompt on the
      // dApp's very first read.
      const granted = yield* deps.sessions.isConnected(origin, outcome.groupId, outcome.accountIndex)
      if (!granted) {
        return {id: payload.id, error: {code: ApiErrorCode.InternalError, message: 'could not save the connection'}}
      }
      // enable/isEnabled resolve to the granted API (the provider builds the api object on `true`).
      return {id: payload.id, result: true}
    })

  const onSignRequired = (payload: DappMessage, details: SignRequestDetails): Effect.Effect<WalletResponse> =>
    Effect.gen(function* () {
      // A random id, not a counter: the worker restarts freely and a restarted
      // counter would let a stale reply settle a fresh request.
      const requestId = `sign-${crypto.randomUUID()}`
      const d = deferred<SignOutcome>(timeoutMs, {
        error: {code: ApiErrorCode.InternalError, message: 'request timed out'},
      })
      pendingSigns.set(requestId, d.settle)
      signRequests.set(requestId, details)
      deps.broadcast({type: 'NAVIGATE_CONFIRM_SIGN', requestId, signType: details.signType, origin: details.origin})
      const outcome = yield* Effect.promise(() =>
        d.promise.finally(() => {
          pendingSigns.delete(requestId)
          signRequests.delete(requestId)
        }),
      )
      return outcome.error ? {id: payload.id, error: outcome.error} : {id: payload.id, result: outcome.result}
    })

  const handle = (payload: DappMessage, verifiedOrigin: string): Promise<WalletResponse> => {
    const origin = keyableOrigin(verifiedOrigin)
    if (origin === null) {
      return Promise.resolve({
        id: payload.id,
        error: {code: ApiErrorCode.Refused, message: 'request origin could not be verified'},
      })
    }
    // Every downstream origin read (session lookup, approval prompt) comes from
    // here, so the page's own `origin` field never reaches the resolver.
    const trusted: DappMessage = {...payload, origin}

    return Effect.runPromise(
      resolver.resolve(trusted).pipe(
        Effect.catchTags({
          ConnectionRequired: () => onConnectRequired(trusted, origin),
          SignTxRequired: (e) =>
            onSignRequired(trusted, {signType: 'tx', txHex: e.txHex, partialSign: e.partialSign, origin}),
          SignDataRequired: (e) =>
            onSignRequired(trusted, {
              signType: 'data',
              addressHex: e.addressHex,
              payloadHex: e.payloadHex,
              origin,
            }),
        }),
      ),
    )
  }

  return {
    handle,
    resolveConnect: (origin, outcome) => {
      const key = keyableOrigin(origin)
      if (key !== null) pendingConnects.get(key)?.(outcome)
    },
    resolveSign: (requestId, outcome) => pendingSigns.get(requestId)?.(outcome),
    getSignRequest: (requestId) => signRequests.get(requestId) ?? null,
  }
}
