/**
 * Storage-backed {@link SessionStore} for the dApp connector. Persists the full
 * session list as one JSON blob via the platform storage layer, so authorized
 * (origin, chainType, group) triples survive an app restart. Per-session expiry
 * and invalid-origin pruning stay in `makeSessionManager` — this layer only
 * serializes what the manager hands it.
 *
 * @module
 */

import {
  type DappSession,
  parseDappSession,
  type SessionStore,
  SessionStoreError,
  SessionStoreTag,
} from '@pnyx/dapp-connector'
import type {Storage} from '@pnyx/storage'
import {Effect, Layer} from 'effect'
import {logger} from '../../logger'
import {createProfileStorage} from '../profile/profile-storage'

const KEY = 'dapp.sessions'

// A corrupt blob self-heals to empty rather than trapping the manager on boot.
const parse = (raw: string): readonly DappSession[] => {
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.map(parseDappSession).filter((s): s is DappSession => s !== null)
  } catch (e: unknown) {
    // An empty list reads as "no dApp is connected", which is what the settings screen shows —
    // while the sessions themselves may still be live.
    logger.warn('dApp sessions could not be read; reporting none connected', {
      origin: 'dapp/session-store',
      error: String(e),
    })
    return []
  }
}

/** Read + deserialize the persisted session list (empty when unset or corrupt). */
export const loadSessions = (storage: Storage): Effect.Effect<readonly DappSession[], SessionStoreError> =>
  storage.get(KEY).pipe(
    Effect.map((raw) => (raw === null ? [] : parse(raw))),
    Effect.mapError((cause) => new SessionStoreError({reason: 'load failed', cause})),
  )

/** Serialize + persist the full session list. */
export const saveSessions = (
  storage: Storage,
  sessions: readonly DappSession[],
): Effect.Effect<void, SessionStoreError> =>
  storage
    .set(KEY, JSON.stringify(sessions))
    .pipe(Effect.mapError((cause) => new SessionStoreError({reason: 'save failed', cause})))

/** Bind the store ops to a concrete storage instance. */
export const makeStorageSessionStore = (storage: Storage): SessionStore => ({
  load: loadSessions(storage),
  save: (sessions) => saveSessions(storage, sessions),
})

/** Platform-storage-backed session store layer for the app runtime. */
export const StorageSessionStore: Layer.Layer<SessionStoreTag> = Layer.sync(SessionStoreTag, () =>
  makeStorageSessionStore(createProfileStorage()),
)
