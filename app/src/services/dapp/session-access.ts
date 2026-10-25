/**
 * The app's read/revoke access to dApp sessions, over whichever store the
 * current runtime shares with its connector.
 *
 * On the extension that store **must** be `chrome.storage` — the app bundle at
 * `chrome-extension://` also has `localStorage`, so the platform store would
 * appear to work while leaving the service worker looking at a different set of
 * sessions. Elsewhere (native, plain web) the in-app browser's platform store is
 * the only one. See `docs/CONNECTED_DAPPS.md`.
 *
 * The store instance is created once per process: the manager is rebuilt per
 * operation to stay read-through, and an in-memory store handed out per call
 * would lose its state.
 *
 * @module
 */

import {
  type DappSession,
  makeSessionManager,
  type SessionManager,
  type SessionStore,
  SessionStoreTag,
} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {makeChromeSessionStore} from '../../../extension/dapp/session-store'
import {isExtension} from '../../platform/extension/runtime'
import {createProfileStorage} from '../profile/profile-storage'
import {makeStorageSessionStore} from './session-store'

let store: SessionStore | null = null

/** The session store shared with this runtime's dApp connector. */
export const dappSessionStore = (): SessionStore => {
  if (store === null) {
    store = isExtension ? makeChromeSessionStore() : makeStorageSessionStore(createProfileStorage())
  }
  return store
}

/** Run one operation against a freshly hydrated manager (expiry pruning included). */
const withManager = <A, E>(use: (manager: SessionManager) => Effect.Effect<A, E>) =>
  makeSessionManager.pipe(Effect.flatMap(use), Effect.provideService(SessionStoreTag, dappSessionStore()))

/** Every live (unexpired) session. */
export const listDappSessions = (): Promise<readonly DappSession[]> =>
  Effect.runPromise(withManager((manager) => manager.sessions))

/** Revoke one grant. */
export const revokeDappSession = (session: DappSession): Promise<void> =>
  Effect.runPromise(
    withManager((manager) =>
      manager.disconnect(session.origin, session.chainType, session.groupId, session.accountIndex),
    ),
  )

/** Revoke every grant. */
export const revokeAllDappSessions = (): Promise<void> => Effect.runPromise(withManager((manager) => manager.clear))
