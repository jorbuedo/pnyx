/**
 * The one canonical Cardano chain id, and the CIP-34 alias we accept on ingress.
 *
 * Two spellings of "which Cardano network" were in use: CAIP-2 `cardano:mainnet` (what
 * {@link ChainId} models and what the app persists) and CIP-34 `cip34:1-764824073` (what the
 * co-sign envelope wrote into a field typed as a bare string, both to storage and to the wire).
 * A single persisted concept with two spellings is the kind of thing that reads fine until two
 * subsystems compare ids and silently disagree.
 *
 * So: **`cardano:*` is canonical everywhere we persist or compare**, CIP-34 is accepted when
 * parsing anything that came from outside, and nothing emits CIP-34 except a serializer that
 * explicitly needs it for compatibility. x402's Cardano scheme settles the same coin flip the
 * same way — its canonical ids are `cardano:mainnet|preprod|preview`, with CIP-34 forms treated
 * as equivalent aliases.
 *
 * @module
 */

import {CARDANO_MAINNET, CARDANO_PREPROD, CARDANO_PREVIEW} from './types.js'

/** The Cardano networks the wallet can be pointed at. */
export type CardanoNetwork = 'mainnet' | 'preprod' | 'preview'

/** Canonical CAIP-2 ids for the Cardano family. */
export type CardanoChainId = typeof CARDANO_MAINNET | typeof CARDANO_PREPROD | typeof CARDANO_PREVIEW

/** Protocol magic per network — the second half of a CIP-34 reference. */
export const CARDANO_PROTOCOL_MAGIC: Readonly<Record<CardanoNetwork, number>> = {
  mainnet: 764824073,
  preprod: 1,
  preview: 2,
}

const BY_NETWORK: Readonly<Record<CardanoNetwork, CardanoChainId>> = {
  mainnet: CARDANO_MAINNET,
  preprod: CARDANO_PREPROD,
  preview: CARDANO_PREVIEW,
}

/** The canonical chain id for a network name. */
export const cardanoChainId = (network: CardanoNetwork): CardanoChainId => BY_NETWORK[network]

/** The network name a canonical chain id denotes. */
export const cardanoNetworkOf = (chainId: CardanoChainId): CardanoNetwork =>
  chainId === CARDANO_MAINNET ? 'mainnet' : chainId === CARDANO_PREPROD ? 'preprod' : 'preview'

/**
 * The canonical id for a CIP-34 `cip34:<networkId>-<protocolMagic>` string, or `null` when the
 * string is not a CIP-34 id or names a network we do not model.
 *
 * `networkId` alone cannot identify a testnet — preprod and preview share `0` — so the
 * protocol magic decides, and a `0` network id with an unknown magic is **not** silently
 * resolved to preprod.
 */
export const chainIdFromCip34 = (value: string): CardanoChainId | null => {
  const match = /^cip34:(\d+)-(\d+)$/.exec(value.trim())
  if (match === null) return null
  const networkId = Number(match[1])
  const magic = Number(match[2])

  if (networkId === 1) return magic === CARDANO_PROTOCOL_MAGIC.mainnet ? CARDANO_MAINNET : null
  if (networkId !== 0) return null
  if (magic === CARDANO_PROTOCOL_MAGIC.preprod) return CARDANO_PREPROD
  if (magic === CARDANO_PROTOCOL_MAGIC.preview) return CARDANO_PREVIEW
  return null
}

/** True for a canonical Cardano chain id. */
export const isCardanoChainId = (value: string): value is CardanoChainId =>
  value === CARDANO_MAINNET || value === CARDANO_PREPROD || value === CARDANO_PREVIEW

/**
 * Normalize anything chain-id-shaped that arrived from outside — canonical or CIP-34 — to the
 * canonical form. `null` when it is neither, so a caller can reject rather than guess.
 */
export const normalizeCardanoChainId = (value: string): CardanoChainId | null => {
  const trimmed = value.trim()
  return isCardanoChainId(trimmed) ? trimmed : chainIdFromCip34(trimmed)
}

/**
 * The CIP-34 spelling, for a wire format that requires it.
 *
 * Deliberately explicit: nothing should reach for this to fill a field that {@link ChainId}
 * already models.
 */
export const cip34Of = (chainId: CardanoChainId): string => {
  const network = cardanoNetworkOf(chainId)
  return `cip34:${network === 'mainnet' ? 1 : 0}-${CARDANO_PROTOCOL_MAGIC[network]}`
}
