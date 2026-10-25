/**
 * Persistence for the device's Midnight endpoint overrides.
 *
 * Kept apart from the in-memory registry so that resolving an endpoint — which happens on hot
 * paths, from modules that have no business knowing about storage — stays free of IO. This module
 * is imported by exactly two callers: the boot path that loads, and the settings screen that saves.
 *
 * Profile-scoped, like every key not on the device-global allowlist: a decoy profile keeps its own
 * endpoints and nothing about the real profile's configuration shows through.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'

import type {EndpointKind} from '../../config/chain-endpoints'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {
  applyClearNetworkOverrides,
  applyUserEndpointOverride,
  ENDPOINT_KINDS,
  type EndpointOverrides,
  installUserEndpointOverrides,
  type NetworkEndpoints,
  OVERRIDABLE_NETWORKS,
} from './endpoint-overrides'

/** Documented in `docs/STORAGE_KEYS.md`. */
export const MIDNIGHT_ENDPOINTS_KEY = '@pnyx/midnight_endpoint_overrides'

/** Bumped only if the stored shape changes; an unknown version is discarded, never guessed at. */
const SCHEMA_VERSION = 1

type StoredOverrides = {readonly version: number; readonly networks: EndpointOverrides}

/**
 * Parse what was persisted, keeping only what this build understands.
 *
 * Anything unrecognised is dropped rather than carried: a stray key reaching `networks.ts` would
 * become a URL the wallet sends its queries to, and "the stored blob said so" is not reason enough.
 */
export const parseStoredOverrides = (raw: string | null | undefined): EndpointOverrides => {
  if (raw === null || raw === undefined || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn('midnight endpoint overrides: stored value is not JSON, ignoring', {error: String(error)})
    return {}
  }
  const stored = parsed as Partial<StoredOverrides>
  if (stored?.version !== SCHEMA_VERSION) {
    logger.warn('midnight endpoint overrides: unknown schema version, ignoring', {version: String(stored?.version)})
    return {}
  }
  const out: EndpointOverrides = {}
  for (const network of OVERRIDABLE_NETWORKS) {
    const entry = stored.networks?.[network]
    if (entry === undefined) continue
    const kept: NetworkEndpoints = {}
    for (const kind of ENDPOINT_KINDS) {
      const value = entry[kind]
      if (typeof value === 'string' && value.trim() !== '') kept[kind] = value.trim()
    }
    if (Object.keys(kept).length > 0) out[network] = kept
  }
  return out
}

/** The bytes to persist for a set of overrides. */
export const serializeOverrides = (overrides: EndpointOverrides): string =>
  JSON.stringify({version: SCHEMA_VERSION, networks: overrides} satisfies StoredOverrides)

const persist = async (overrides: EndpointOverrides): Promise<void> => {
  try {
    if (Object.keys(overrides).length === 0) await storage.remove(MIDNIGHT_ENDPOINTS_KEY)
    else await storage.set(MIDNIGHT_ENDPOINTS_KEY, serializeOverrides(overrides))
  } catch (error) {
    // The value is already live in memory, so the app behaves as asked; what is lost is the next
    // launch. Saying so is the difference between "my endpoint reset itself" and a diagnosable fault.
    logger.error('midnight endpoint override could not be persisted; it will not survive a restart', {
      error: String(error),
    })
  }
}

/**
 * Load the persisted overrides into the registry.
 *
 * Called once from the boot path. A failure leaves the registry empty, which means the built-in
 * endpoints — the app works, it just is not overridden.
 */
export const loadEndpointOverrides = async (): Promise<void> => {
  try {
    const raw = await storage.get(MIDNIGHT_ENDPOINTS_KEY)
    const overrides = parseStoredOverrides(raw)
    installUserEndpointOverrides(overrides)
    logger.debug('midnight endpoint overrides loaded', {
      networks: Object.keys(overrides).join(',') || 'none',
    })
  } catch (error) {
    logger.warn('midnight endpoint overrides could not be read; using built-in endpoints', {error: String(error)})
  }
}

/** Set or clear one override: live immediately, persisted behind it. */
export const saveUserEndpointOverride = async (
  network: Network,
  kind: EndpointKind,
  value: string | null,
): Promise<void> => {
  const next = applyUserEndpointOverride(network, kind, value)
  logger.info('midnight endpoint override changed', {network, kind, cleared: value === null || value.trim() === ''})
  await persist(next)
}

/** Drop every override for one network. */
export const clearNetworkEndpointOverrides = async (network: Network): Promise<void> => {
  const next = applyClearNetworkOverrides(network)
  logger.info('midnight endpoint overrides cleared for network', {network})
  await persist(next)
}
