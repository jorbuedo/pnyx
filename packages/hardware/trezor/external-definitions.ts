/**
 * Trezor external definitions fetcher.
 *
 * Fetches signed token/network definitions from data.trezor.io so the Trezor
 * device can display human-readable token names and network info during signing.
 * Without these, the device shows "unknown token" / "unknown network".
 *
 * The .dat files are signed by Trezor (CoSi Ed25519) and verified by firmware —
 * they cannot be tampered with even over plain HTTP.
 *
 * @see https://docs.trezor.io/trezor-firmware/common/external-definitions.html
 * @module
 */

import {getLogger} from '@pnyx/logger'

const logger = getLogger('hardware')
const ORIGIN = 'TrezorDefinitions'

const BASE_URL = 'https://data.trezor.io/firmware/definitions'
const FETCH_TIMEOUT_MS = 5_000

/** Fetch a .dat file, returning raw bytes as hex string. Returns undefined on 404 or error. */
const fetchDefinitionFile = async (url: string): Promise<string | undefined> => {
  // Hermes has no `AbortSignal.timeout`, so the deadline is a controller by hand. Reaching for
  // the static threw before the request was made, and the catch below reported that as a plain
  // miss — so on device no definition ever loaded and it looked like a 404.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {signal: controller.signal})
    if (response.status === 200) {
      const buf = new Uint8Array(await response.arrayBuffer())
      // Convert to hex string — protobuf encoder expects bytes fields as hex
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
    }
    if (response.status !== 404) {
      logger.warn(`Unexpected status ${response.status} fetching ${url}`, {origin: ORIGIN})
    }
  } catch (e) {
    logger.warn(`Failed to fetch definition: ${url}`, {origin: ORIGIN, cause: e})
  } finally {
    clearTimeout(timer)
  }
  return undefined
}

/**
 * Fetch Ethereum network and token definitions for Trezor device display.
 *
 * - Skips for Ethereum mainnet (chainId=1) simple transfers (firmware knows natively)
 * - Token definition is fetched when the tx has calldata (contract interaction)
 * - All failures are silent — signing proceeds with "unknown" display
 */
export const fetchEthereumDefinitions = async (params: {
  chainId: number
  to?: string
  data?: string
}): Promise<{encoded_network?: string; encoded_token?: string}> => {
  const {chainId, to, data} = params
  const hasData = data != null && data.replace(/^0x/i, '').length > 0

  // Ethereum mainnet simple transfer — firmware knows natively
  if (chainId === 1 && !hasData) return {}

  const result: {encoded_network?: string; encoded_token?: string} = {}

  // Fetch network + token in parallel
  const networkUrl = `${BASE_URL}/eth/chain-id/${chainId}/network.dat`
  const tokenUrl =
    hasData && to ? `${BASE_URL}/eth/chain-id/${chainId}/token-${to.replace(/^0x/i, '').toLowerCase()}.dat` : null

  const [network, token] = await Promise.all([
    fetchDefinitionFile(networkUrl),
    tokenUrl ? fetchDefinitionFile(tokenUrl) : Promise.resolve(undefined),
  ])

  if (network) result.encoded_network = network
  if (token) result.encoded_token = token

  return result
}

/**
 * Fetch Solana token definition for Trezor device display.
 *
 * @param mintAddress - SPL token mint address (base58)
 * @returns hex string of .dat file contents, or undefined
 */
export const fetchSolanaTokenDefinition = async (mintAddress: string): Promise<string | undefined> =>
  fetchDefinitionFile(`${BASE_URL}/solana/token/${mintAddress}.dat`)
