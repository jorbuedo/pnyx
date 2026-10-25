/**
 * Message resolver: routes a {@link DappMessage} to the chain handler's method,
 * folds handler wire errors into the response, and lets sentinel errors pass
 * through the typed failure channel for the host app to catch.
 *
 * @module
 */

import {Effect} from 'effect'
import type {ChainType, DappMessage, MidnightErrorCode, SentinelError, WalletResponse} from './types.js'
import {ApiErrorCode, WireError} from './types.js'

/** Per-method handler. Fails `WireError` for dApp-facing errors, sentinels for UI routing. */
export type MethodHandler = (
  params: unknown,
  context: RequestContext,
) => Effect.Effect<unknown, WireError | SentinelError>

export type RequestContext = {
  readonly origin: string
  readonly sessionId?: string
  readonly chainType: ChainType
}

export type ChainHandler = {
  readonly chainType: ChainType
  readonly methods: ReadonlyMap<string, MethodHandler>
}

export type ResolverConfig = {
  readonly handlers: ReadonlyMap<ChainType, ChainHandler>
  /** Observability hook for defects (unexpected throws) — not wire/sentinel errors. */
  readonly onDefect?: (defect: unknown, message: DappMessage) => void
}

export type Resolver = {
  readonly resolve: (message: DappMessage) => Effect.Effect<WalletResponse, SentinelError>
  readonly isSupported: (chainType: ChainType, method: string) => boolean
  readonly supportedMethods: (chainType: ChainType) => readonly string[]
}

export const createResolver = (config: ResolverConfig): Resolver => {
  // The Midnight code is only meaningful to a Midnight page; a Cardano one has no such union and its
  // provider would ignore the field anyway. Attaching it by chain keeps the wire honest either way.
  const forMidnight = (chainType: ChainType, apiCode: MidnightErrorCode) => (chainType === 'midnight' ? {apiCode} : {})

  const resolve = (message: DappMessage): Effect.Effect<WalletResponse, SentinelError> => {
    const handler = config.handlers.get(message.chainType)
    if (!handler) {
      return Effect.succeed({
        id: message.id,
        error: {
          code: ApiErrorCode.InvalidRequest,
          ...forMidnight(message.chainType, 'InvalidRequest'),
          message: `chain "${message.chainType}" is not supported`,
        },
      })
    }
    const method = handler.methods.get(message.method)
    if (!method) {
      return Effect.succeed({
        id: message.id,
        error: {
          code: ApiErrorCode.InvalidRequest,
          ...forMidnight(message.chainType, 'InvalidRequest'),
          message: `method "${message.method}" is not supported for ${message.chainType}`,
        },
      })
    }
    const context: RequestContext = {
      origin: message.origin,
      chainType: message.chainType,
      ...(message.sessionId !== undefined ? {sessionId: message.sessionId} : {}),
    }
    return method(message.params, context).pipe(
      Effect.map((result): WalletResponse => ({id: message.id, result})),
      Effect.catchTag('WireError', (error) =>
        Effect.succeed<WalletResponse>({
          id: message.id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined ? {data: error.data} : {}),
            ...(error.apiCode !== undefined ? forMidnight(message.chainType, error.apiCode) : {}),
          },
        }),
      ),
      Effect.catchAllDefect((defect) => {
        config.onDefect?.(defect, message)
        return Effect.succeed<WalletResponse>({
          id: message.id,
          error: {
            code: ApiErrorCode.InternalError,
            ...forMidnight(message.chainType, 'InternalError'),
            message: defect instanceof Error ? defect.message : 'internal error',
          },
        })
      }),
    )
  }

  return {
    resolve,
    isSupported: (chainType, method) => config.handlers.get(chainType)?.methods.has(method) ?? false,
    supportedMethods: (chainType) => [...(config.handlers.get(chainType)?.methods.keys() ?? [])],
  }
}

/**
 * Wire error for a request from an origin without an active session.
 *
 * `PermissionRejected` rather than `Rejected`: nobody declined this request — the page was never
 * granted the permission it needs. Midnight's API separates the two and a dApp acts on them
 * differently (ask for a connection, versus stop asking). The field reaches only Midnight pages.
 */
export const refused = (message = 'not connected'): WireError =>
  new WireError({code: ApiErrorCode.Refused, message, apiCode: 'PermissionRejected'})

/**
 * Wire error for a method this wallet declares but cannot perform.
 *
 * `InternalError`, whose own documentation is "the dapp connector wasn't able to process the request" —
 * which is exactly this. Not `InvalidRequest` (the page asked correctly) and not `Rejected` (nobody
 * declined it).
 *
 * **Why declare a method only to refuse it.** The spec's `ConnectedAPI` marks no method optional, so a
 * dApp typed against the SDK expects every one of them present, and an absent method gives it a
 * `TypeError` instead of an `APIError` it can branch on. `hintUsage(Array<keyof WalletConnectedAPI>)`
 * says the same thing about the intended discovery route: hint and handle the error, not presence-test.
 * A stub carrying a specific, documented reason is an answer; the thing to avoid is a *declared* method
 * with no handler at all, which is what silently threw "not supported" before.
 */
export const unsupported = (message: string): WireError =>
  new WireError({code: ApiErrorCode.InternalError, message, apiCode: 'InternalError'})

/** Wire error for malformed dApp input. */
export const invalidRequest = (message: string, data?: unknown): WireError =>
  new WireError({
    code: ApiErrorCode.InvalidRequest,
    message,
    apiCode: 'InvalidRequest',
    ...(data !== undefined ? {data} : {}),
  })
