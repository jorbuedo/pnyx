/**
 * The two mutable sources of Midnight endpoints: what this device overrode, and what the control
 * plane last published.
 *
 * **In memory only, by design.** `networks.ts` answers "which endpoint?" synchronously from
 * everywhere, including paths React never reaches. If that lookup touched storage, every module
 * that resolves an endpoint would inherit a dependency on MMKV and a profile prefix — which is
 * exactly what happened the first time this was written, and it reached a dozen unrelated modules.
 * Loading and saving live next door in `endpoint-overrides-store.ts`; this file only remembers.
 *
 * **Why a device-local override exists at all.** On 2026-09-30 Midnight decommissioned the mainnet
 * indexer host, and every build with that URL compiled in kept calling a name that no longer
 * resolves. A fleet-wide fix needs the control plane; a single device needs a text field. Both are
 * here, and the device wins, because the person holding it can see what is broken sooner than we
 * can.
 *
 * @module
 */

import type {RemoteNetworksConfig} from '@pnyx/config'
import type {Network} from '@pnyx/wallet'

import {remoteMidnightEndpoints} from '../../config/chain-availability'
import type {EndpointKind} from '../../config/chain-endpoints'

export type NetworkEndpoints = Partial<Record<EndpointKind, string>>
export type EndpointOverrides = Partial<Record<Network, NetworkEndpoints>>

export const ENDPOINT_KINDS: readonly EndpointKind[] = ['indexer', 'node', 'nodeWs']
export const OVERRIDABLE_NETWORKS: readonly Network[] = ['mainnet', 'preprod', 'preview']

/**
 * An immutable view of both mutable sources, whose **identity changes on every write**.
 *
 * ⚠️ This exists because the app compiles with React Compiler (`app.config.js`,
 * `experiments.reactCompiler`), which re-derives memoization from the data a component actually
 * reads and **ignores hand-written dependency arrays**. A `revision` counter in a dep array is not
 * read by the memo body, so the compiler treats it as unused and never recomputes — the screen then
 * shows, and tests, an endpoint that is no longer in force. A snapshot threaded through
 * `useSyncExternalStore` is a real dependency, which is the one shape that survives the compiler.
 */
export type EndpointRegistrySnapshot = {
  readonly user: EndpointOverrides
  readonly remote: RemoteNetworksConfig | undefined
}

let userOverrides: EndpointOverrides = {}
let remoteRules: RemoteNetworksConfig | undefined
let snapshot: EndpointRegistrySnapshot = {user: userOverrides, remote: remoteRules}
const listeners = new Set<(error?: unknown) => void>()

/** The current snapshot. Stable between writes, so `useSyncExternalStore` will not loop. */
export const getEndpointRegistrySnapshot = (): EndpointRegistrySnapshot => snapshot

const notify = (): void => {
  snapshot = {user: userOverrides, remote: remoteRules}
  for (const listener of listeners) listener()
}

/** Everything this device has overridden. */
export const currentUserOverrides = (): EndpointOverrides => userOverrides

/** One override, or `undefined` when this device has not set it. */
export const userEndpointOverride = (network: Network, kind: EndpointKind): string | undefined =>
  userOverrides[network]?.[kind]

/** Replace the whole override set. Used when the persisted value is loaded at boot. */
export const installUserEndpointOverrides = (overrides: EndpointOverrides): void => {
  userOverrides = overrides
  notify()
}

/**
 * Set or clear one override in memory. Pass `null` to clear.
 *
 * Returns the resulting set so the caller can persist exactly what is now live, rather than
 * re-deriving it and risking the two disagreeing.
 */
export const applyUserEndpointOverride = (
  network: Network,
  kind: EndpointKind,
  value: string | null,
): EndpointOverrides => {
  const next: EndpointOverrides = {...userOverrides}
  const entry: NetworkEndpoints = {...next[network]}
  if (value === null || value.trim() === '') delete entry[kind]
  else entry[kind] = value.trim()
  if (Object.keys(entry).length === 0) delete next[network]
  else next[network] = entry
  userOverrides = next
  notify()
  return next
}

/** Drop every override for one network, returning the resulting set. */
export const applyClearNetworkOverrides = (network: Network): EndpointOverrides => {
  const next: EndpointOverrides = {...userOverrides}
  delete next[network]
  userOverrides = next
  notify()
  return next
}

/** What the control plane last published for a network and kind, or `undefined`. */
export const remoteEndpointDefault = (network: Network, kind: EndpointKind): string | undefined =>
  remoteMidnightEndpoints(remoteRules, network)?.[kind]

/** The rule matrix the control plane last published. */
export const currentRemoteRules = (): RemoteNetworksConfig | undefined => remoteRules

/**
 * Install the control plane's rules. Called when remote config loads or refreshes.
 *
 * `undefined` clears them, which is what an absent or failed fetch means: fall back to the build,
 * never to a stale shutdown that nobody can lift.
 */
export const setRemoteNetworkRules = (rules: RemoteNetworksConfig | undefined): void => {
  remoteRules = rules
  notify()
}

/** Subscribe to changes — the settings screen re-reads through this rather than polling. */
export const subscribeEndpointOverrides = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget everything installed. Never called by the app. */
export const resetEndpointOverridesForTest = (): void => {
  userOverrides = {}
  remoteRules = undefined
  listeners.clear()
}
