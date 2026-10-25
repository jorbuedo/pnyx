/**
 * The narrow session port the background dApp router depends on, built over the
 * canonical `makeSessionManager`.
 *
 * The manager hydrates into a `Ref` at construction, so a long-lived instance in
 * the service worker would never see a revoke performed by the app. This builds
 * a **fresh manager per call** — it re-reads the store, prunes expired rows and
 * persists on mutation, which is read-through semantics and cheap at CIP-30
 * request rates. That is also why the app can mutate sessions directly instead of
 * routing every change through a `chrome.runtime` message.
 *
 * Store failures fail *closed*: an unreadable store reports "not connected", so
 * the user is asked to approve again rather than being silently trusted. That
 * covers thrown errors too (a `chrome.storage` callback raising is a defect, not
 * a typed failure) — authorization must never be granted by an error path.
 *
 * @module
 */

import {
  type ChainType,
  makeSessionManager,
  type SessionManager,
  type SessionStore,
  type SessionStoreError,
  SessionStoreTag,
} from '@pnyx/dapp-connector'
import {Effect} from 'effect'

/** The extension injects a Cardano provider only. */
const CHAIN: ChainType = 'cardano'

export type SessionPort = {
  /**
   * Connected for this origin — narrowed to the given wallet group and account,
   * or any when they're omitted.
   */
  readonly isConnected: (origin: string, groupId?: string, accountIndex?: number) => Effect.Effect<boolean>
  /** `ttlMs` is the grant lifetime; `null` keeps it until the user revokes it. */
  readonly connect: (origin: string, groupId: string, accountIndex: number, ttlMs: number | null) => Effect.Effect<void>
}

/**
 * Run one operation against a freshly hydrated manager. Takes the store
 * *instance*, not a layer: `Effect.provide` rebuilds a layer on every execution,
 * which would hand each call its own state for any store holding it in memory.
 */
const withManager = <A, E>(
  store: SessionStore,
  use: (manager: SessionManager) => Effect.Effect<A, E>,
): Effect.Effect<A, E | SessionStoreError> =>
  makeSessionManager.pipe(Effect.flatMap(use), Effect.provideService(SessionStoreTag, store))

/** Build the router's session port over a session store. */
export const makeSessionPort = (store: SessionStore): SessionPort => ({
  isConnected: (origin, groupId, accountIndex) =>
    withManager(store, (manager) => manager.isConnected(origin, CHAIN, groupId, accountIndex)).pipe(
      Effect.catchAllCause(() => Effect.succeed(false)),
    ),
  connect: (origin, groupId, accountIndex, ttlMs) =>
    withManager(store, (manager) => Effect.asVoid(manager.connect(origin, CHAIN, groupId, accountIndex, ttlMs))).pipe(
      Effect.catchAllCause(() => Effect.void),
    ),
})
