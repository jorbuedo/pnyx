/**
 * Cardano rail configuration — network selection + the first-party Koios
 * endpoint. Per the Third-Party RPC policy the rail is UNAVAILABLE without a
 * configured endpoint: `getCardanoRailConfig()` returns `null` and callers
 * must surface the absence (no public-instance fallback, ever).
 *
 * The network is chosen at **runtime**: `ConfigProvider` pushes the user's
 * selection in via {@link setActiveCardanoNetwork}, and every `getCardanoRailConfig()`
 * caller picks it up on its next read. Session caches keyed by something that
 * is not itself network-specific (asset ids, pool ids) must drop their contents
 * via {@link onCardanoNetworkChange}.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'
import {cardanoKoiosUrlOverride, cardanoNetworkOverride} from '../../config/env'
import {DEFAULT_NETWORK} from '../../config/networks'

/**
 * The networks this wallet reads.
 *
 * ⚠️ Pnyx's own vocabulary, not a provider's. These literals **are persisted** — the user's
 * network selection is stored under them and `ConfigProvider` is the source of truth — so they
 * are a storage format, lowercase, and they do not follow whatever an SDK calls its networks.
 */
export type CardanoNetwork = 'mainnet' | 'preprod' | 'preview'

export type CardanoRailConfig = {
  readonly network: CardanoNetwork
  /** First-party / self-hosted Koios-compatible base URL. */
  readonly koiosUrl: string
  /** 0 = testnets, 1 = mainnet. */
  readonly networkId: number
  /** CIP-142 network magic. */
  readonly protocolMagic: number
}

const NETWORKS: readonly CardanoNetwork[] = ['mainnet', 'preprod', 'preview']

/**
 * ADA Handle minting policy id per network (CIP-25 NFT). Handle → address
 * resolution looks up the current holder of the handle NFT under this policy.
 * Testnet deployments differ; only mainnet is populated here (others → no
 * handle resolution, not a fabricated fallback).
 */
export const ADA_HANDLE_POLICY: Record<CardanoNetwork, string | null> = {
  mainnet: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
  preprod: null,
  preview: null,
}

/**
 * CNS (Cardano Name Service) resolver. The hosted API is mainnet-only (the
 * backend does the on-chain NFT lookup via the two policy ids); `null` on
 * testnets → CNS unavailable there. Swappable via a future first-party backend.
 */
export type CnsConfig = {readonly url: string; readonly cnsPolicyId: string; readonly cnsRecordPolicyId: string}
export const CNS_CONFIG: Record<CardanoNetwork, CnsConfig | null> = {
  mainnet: {
    url: 'https://api.cardanoname.service/api/v0/cns/resolve',
    cnsPolicyId: '91e42c37e3ddcfbc49c1b1e5b5c049b8e4e4b88c3d1711e0b702c73a',
    cnsRecordPolicyId: '2a22bcabb377c15e452f5f7a616008610e1e19e4b71c40b76f4d0783',
  },
  preprod: null,
  preview: null,
}

const PROTOCOL_MAGIC: Record<CardanoNetwork, number> = {
  mainnet: 764824073,
  preprod: 1,
  preview: 2,
}

// Expo inlines `process.env.EXPO_PUBLIC_*` only when the member expression is
// literal — do not refactor into dynamic lookups.
const rawNetwork = cardanoNetworkOverride()
const rawKoiosUrl = cardanoKoiosUrlOverride()

const parseNetwork = (value: string | undefined): CardanoNetwork =>
  NETWORKS.includes(value as CardanoNetwork) ? (value as CardanoNetwork) : 'mainnet'

// Default Koios endpoint per network so the Cardano rail is available in every
// environment without requiring EXPO_PUBLIC_CARDANO_KOIOS_URL to be set (that
// env var still overrides). Koios is the project's Cardano API; these are the
// same public hosts the rail's own harness uses. NOTE: docs/AUDIT-2026-07-14 §1.5 flags
// defaulting to public Koios hosts — the follow-up is to point these at a
// first-party (self-hosted/keyed) Koios; swap the values here when that exists.
const DEFAULT_KOIOS_URL: Record<CardanoNetwork, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

/** Build the rail config from env overrides (test seam). */
export const cardanoRailConfigFrom = (env: {
  readonly network?: string
  readonly koiosUrl?: string
}): CardanoRailConfig | null => {
  const koiosUrl = env.koiosUrl?.trim()
  if (koiosUrl === undefined || koiosUrl.length === 0) return null
  const network = parseNetwork(env.network)
  return {
    network,
    koiosUrl,
    networkId: network === 'mainnet' ? 1 : 0,
    protocolMagic: PROTOCOL_MAGIC[network],
  }
}

/** The network `EXPO_PUBLIC_CARDANO_KOIOS_URL` (if set) is an endpoint for. */
const envNetwork = parseNetwork(rawNetwork)

/**
 * Koios base for a network. The env override names exactly one network — it is
 * an endpoint for *that* chain, so applying it to the others would point
 * preprod reads at a mainnet host.
 */
const koiosUrlFor = (network: CardanoNetwork): string => {
  const envKoios = rawKoiosUrl?.trim()
  return envKoios !== undefined && envKoios.length > 0 && envNetwork === network ? envKoios : DEFAULT_KOIOS_URL[network]
}

let activeNetwork: CardanoNetwork = DEFAULT_NETWORK
const networkChangeListeners = new Set<() => void>()

/** The network the rail is currently reading. */
export const getActiveCardanoNetwork = (): CardanoNetwork => activeNetwork

/**
 * Point the rail at a network. Owned by `ConfigProvider` — the persisted user
 * selection is the source of truth and `DEFAULT_NETWORK` only covers the gap
 * before it has loaded. Notifies {@link onCardanoNetworkChange} listeners when
 * the value actually changes.
 */
export const setActiveCardanoNetwork = (network: Network): void => {
  if (network === activeNetwork) return
  activeNetwork = network
  for (const listener of networkChangeListeners) listener()
}

/**
 * Register a listener for network changes, for session caches whose keys are
 * not themselves network-specific (an asset id or pool id can exist on more
 * than one network, so a mainnet entry must not answer a preprod read).
 * Returns the unsubscribe function.
 */
export const onCardanoNetworkChange = (listener: () => void): (() => void) => {
  networkChangeListeners.add(listener)
  return () => networkChangeListeners.delete(listener)
}

/**
 * The rail config for the active network. The Koios endpoint defaults per
 * network (see {@link DEFAULT_KOIOS_URL}); `EXPO_PUBLIC_CARDANO_KOIOS_URL`
 * overrides the network it was configured for. Effectively never null now — the
 * rail is only "unavailable" when there's no Cardano address (see useCardanoRail).
 */
export const getCardanoRailConfig = (): CardanoRailConfig | null =>
  cardanoRailConfigFrom({network: activeNetwork, koiosUrl: koiosUrlFor(activeNetwork)})
