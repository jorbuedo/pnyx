/// <reference types="chrome" />
/**
 * `SessionStoreTag` layer backed by `chrome.storage.local`, so the extension's
 * dApp sessions go through the canonical `makeSessionManager` (expiry,
 * normalization, invalid-origin pruning) rather than a parallel store.
 *
 * **Both extension halves must use this layer.** The app bundle at
 * `chrome-extension://` also has `localStorage`, so the platform-storage layer
 * would appear to work there and silently give the app and the service worker
 * two divergent session sets — and the worker has no `localStorage` at all, so
 * `chrome.storage` is the only medium they share. See `docs/CONNECTED_DAPPS.md`.
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
import {Effect, Layer} from 'effect'
import {DAPP_SESSIONS_KEY} from './protocol'

const hasChromeStorage = (): boolean => typeof chrome !== 'undefined' && !!chrome.storage?.local

/**
 * Read the persisted sessions. Rows failing the shape check are dropped rather
 * than trapping the manager on boot — that retires the pre-unification
 * `{origin, connectedAt}` rows, whose origins simply re-approve.
 */
export const loadChromeSessions: Effect.Effect<readonly DappSession[], SessionStoreError> = Effect.async((resume) => {
  if (!hasChromeStorage()) {
    resume(Effect.fail(new SessionStoreError({reason: 'chrome.storage.local is unavailable'})))
    return
  }
  chrome.storage.local.get(DAPP_SESSIONS_KEY, (record) => {
    if (chrome.runtime.lastError) {
      resume(Effect.fail(new SessionStoreError({reason: chrome.runtime.lastError.message ?? 'load failed'})))
      return
    }
    const raw = record[DAPP_SESSIONS_KEY]
    const rows = Array.isArray(raw) ? raw.map(parseDappSession).filter((s): s is DappSession => s !== null) : []
    resume(Effect.succeed(rows))
  })
})

/** Persist the full session list. */
export const saveChromeSessions = (sessions: readonly DappSession[]): Effect.Effect<void, SessionStoreError> =>
  Effect.async((resume) => {
    if (!hasChromeStorage()) {
      resume(Effect.fail(new SessionStoreError({reason: 'chrome.storage.local is unavailable'})))
      return
    }
    chrome.storage.local.set({[DAPP_SESSIONS_KEY]: sessions}, () => {
      if (chrome.runtime.lastError) {
        resume(Effect.fail(new SessionStoreError({reason: chrome.runtime.lastError.message ?? 'save failed'})))
        return
      }
      resume(Effect.void)
    })
  })

export const makeChromeSessionStore = (): SessionStore => ({
  load: loadChromeSessions,
  save: saveChromeSessions,
})

/** chrome.storage-backed session store layer — the extension's runtime store. */
export const ChromeSessionStore: Layer.Layer<SessionStoreTag> = Layer.sync(SessionStoreTag, makeChromeSessionStore)
