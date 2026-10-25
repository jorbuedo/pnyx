/**
 * Network configuration.
 *
 * The app-level network is named after the Cardano networks (Cardano is the
 * funds chain); other chains map it to their own names — see
 * `midnightNetworkIdForNetwork` in `@pnyx/wallet`. What each network is
 * allowed to do lives in `network-capabilities.ts`.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'
import {cardanoNetworkOverride} from './env'

export type {Network}

/** All selectable networks, in the order the picker shows them. */
export const NETWORKS: readonly Network[] = ['mainnet', 'preprod', 'preview']

/**
 * Accent color per network — the dot in the picker and the header pill's tint.
 * Per-item accents, so the hex is data rather than style (CLAUDE.md).
 */
export const NETWORK_COLORS: Record<Network, string> = {
  mainnet: '#00D4AA',
  preprod: '#FF9500',
  preview: '#A855F7',
}

/**
 * Read a persisted network value.
 *
 * Returns `null` for anything unrecognised — the caller keeps its default
 * rather than inventing a network. The one rewrite is the retired `'testnet'`
 * value: it meant preprod (the old `toCardanoNetwork` mapped testnet → preprod
 * unless explicitly asked for preview), so preprod is what it was, not a guess.
 */
export const parseStoredNetwork = (value: string | null | undefined): Network | null => {
  if (value === 'testnet') return 'preprod'
  return NETWORKS.includes(value as Network) ? (value as Network) : null
}

// Expo inlines `process.env.EXPO_PUBLIC_*` only for literal member expressions —
// do not refactor into a dynamic lookup.
const rawDefaultNetwork = cardanoNetworkOverride()

/**
 * Network a fresh install starts on, before the user has picked one.
 * `EXPO_PUBLIC_CARDANO_NETWORK` is the single build-time network knob — the
 * Cardano rail and the extension manifest builder read the same variable.
 */
export const DEFAULT_NETWORK: Network = parseStoredNetwork(rawDefaultNetwork) ?? 'mainnet'
