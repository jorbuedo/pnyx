/**
 * Stable per-install identifier.
 *
 * A random UUID minted once and persisted, used as the feature-flags rollout
 * key. Stable across app restarts; survives reinstall only if the platform
 * keeps the storage. Pure (no React) so any module can read it — the recovery
 * flow attaches it to a claim and ConfigProvider seeds feature flags with it.
 *
 * @module
 */

import {v4 as uuidv4} from 'uuid'
import {logger} from '../logger'
import {deviceStorage as storage} from './storage'

export const INSTALLATION_ID_STORAGE_KEY = '@pnyx/installation-id'

// The id is read concurrently on first launch (ConfigProvider awaits it), and
// the read-check-write below is not atomic — two callers could otherwise each
// mint a UUID and race the write, so the feature-flags key and a later claim
// would carry different ids. Single-flight collapses concurrent callers onto
// one execution; `cached` serves every later call from memory.
//
// `cached` holds the id for the rest of the session as soon as one is minted —
// even when persistence fails — so the value the feature-flags key uses at
// startup is the SAME one a later claim uses. `persisted` tracks whether it
// actually reached storage; until it has, later calls retry the write (with the
// same id) rather than returning early, so a transient first-launch storage
// error doesn't strand the id on a value that never gets persisted.
let cached: string | null = null
let persisted = false
let inFlight: Promise<string> | null = null

/**
 * Read the persisted installation id, minting and storing one on first call.
 * Concurrent and repeat calls return the same value for the lifetime of the
 * session. On a storage error returns a stable in-memory id (kept for the
 * session) and retries persistence on the next call.
 */
export const getOrCreateInstallationId = async (): Promise<string> => {
  if (cached && persisted) return cached
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      // Always honour an already-persisted id rather than overwriting it — a
      // transient earlier read failure must not clobber a real stored value.
      const existing = await storage.get(INSTALLATION_ID_STORAGE_KEY)
      if (existing) {
        cached = existing
        persisted = true
        return existing
      }
      // Reuse the session id if we already minted one during a prior failed call,
      // so flags/claims stay joined to a single value.
      const id = cached ?? uuidv4()
      await storage.set(INSTALLATION_ID_STORAGE_KEY, id)
      cached = id
      persisted = true
      return id
    } catch (e) {
      logger.error('Failed to get/create installation ID', {origin: 'installation-id', error: e})
      // Keep a stable in-memory id for the session; persistence is retried next call.
      if (!cached) cached = uuidv4()
      return cached
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
