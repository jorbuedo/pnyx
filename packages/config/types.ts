/**
 * CAIP-2 chain identifiers shared across the wallet, hardware, and chain-sync
 * packages.
 *
 * @module
 */

/**
 * Supported blockchain chain identifiers (CAIP-2 format: `namespace:reference`).
 *
 * @see https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 *
 * References:
 * - EVM (`eip155:*`): chain ID from https://chainlist.org
 * - Bitcoin family (`bip122:*`): first 32 hex chars of genesis block hash
 * - Solana (`solana:*`): first 32 chars of genesis block hash
 * - Cardano (`cardano:*`), Tron (`tron:*`), XRPL (`xrpl:*`), Midnight (`midnight:*`):
 *   reference identifies the network (mainnet/preprod/…)
 *
 * To add a new chain, add its CAIP-2 string to this union and export a named constant
 * below. To add a testnet, add a new entry (e.g. `eip155:11155111` for Sepolia); do not
 * repurpose an existing one.
 */
export type ChainId =
  // Cardano family. These are also x402's canonical Cardano network ids, and a facilitator
  // must treat the CIP-34 forms (`cip34:1-764824073`) as equivalent aliases — see
  // `cardanoChainId` / `chainIdFromCip34` for the conversion.
  | 'cardano:mainnet'
  | 'cardano:preprod'
  | 'cardano:preview'
  // UTXO (bip122) — reference is the genesis block hash (first 32 hex chars)
  | 'bip122:000000000019d6689c085ae165831e93' // Bitcoin mainnet
  | 'bip122:000000000000000000651ef99cb9fcbe' // Bitcoin Cash mainnet
  | 'bip122:12a765e31ffd4059bada1e25190f6e98' // Litecoin mainnet
  | 'bip122:1a91e3dace36e2be3bf030a65679fe82' // Dogecoin mainnet
  // EVM (eip155) — reference is the numeric chain ID
  | 'eip155:1' // Ethereum mainnet
  | 'eip155:137' // Polygon mainnet
  | 'eip155:42161' // Arbitrum One
  | 'eip155:10' // Optimism mainnet
  | 'eip155:43114' // Avalanche C-Chain
  | 'eip155:56' // BNB Smart Chain
  | 'eip155:8453' // Base mainnet
  | 'eip155:84532' // Base Sepolia testnet
  | 'eip155:250' // Fantom Opera
  | 'eip155:100' // Gnosis Chain
  | 'eip155:59144' // Linea mainnet
  | 'eip155:534352' // Scroll mainnet
  | 'eip155:324' // zkSync Era
  | 'eip155:5000' // Mantle mainnet
  | 'eip155:42220' // Celo mainnet
  | 'eip155:1284' // Moonbeam
  | 'eip155:1313161554' // Aurora mainnet
  | 'eip155:25' // Cronos mainnet
  | 'eip155:2222' // Kava EVM
  | 'eip155:8217' // Klaytn mainnet
  // Other chains
  | 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' // Solana mainnet-beta
  | 'tron:mainnet' // Tron mainnet
  | 'xrpl:mainnet' // XRP Ledger mainnet
  | 'midnight:mainnet' // Midnight mainnet

// ─── Named constants ───────────────────────────────────────────────────────
// Prefer these over raw string literals at call sites — the hex-encoded bip122
// references in particular are impossible to remember. Compile-time membership
// is still enforced by the ChainId union.

// Cardano family
export const CARDANO_MAINNET: 'cardano:mainnet' = 'cardano:mainnet'
export const CARDANO_PREPROD: 'cardano:preprod' = 'cardano:preprod'
export const CARDANO_PREVIEW: 'cardano:preview' = 'cardano:preview'
// UTXO (bip122)
export const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
export const BITCOIN_CASH_MAINNET = 'bip122:000000000000000000651ef99cb9fcbe'
export const LITECOIN_MAINNET = 'bip122:12a765e31ffd4059bada1e25190f6e98'
export const DOGECOIN_MAINNET = 'bip122:1a91e3dace36e2be3bf030a65679fe82'
// EVM (eip155)
export const ETHEREUM_MAINNET = 'eip155:1'
export const POLYGON_MAINNET = 'eip155:137'
export const ARBITRUM_ONE = 'eip155:42161'
export const OPTIMISM_MAINNET = 'eip155:10'
export const AVALANCHE_MAINNET = 'eip155:43114'
export const BINANCE_MAINNET = 'eip155:56'
export const BASE_MAINNET = 'eip155:8453'
export const BASE_SEPOLIA = 'eip155:84532'
export const FANTOM_MAINNET = 'eip155:250'
export const GNOSIS_MAINNET = 'eip155:100'
export const LINEA_MAINNET = 'eip155:59144'
export const SCROLL_MAINNET = 'eip155:534352'
export const ZKSYNC_MAINNET = 'eip155:324'
export const MANTLE_MAINNET = 'eip155:5000'
export const CELO_MAINNET = 'eip155:42220'
export const MOONBEAM_MAINNET = 'eip155:1284'
export const AURORA_MAINNET = 'eip155:1313161554'
export const CRONOS_MAINNET = 'eip155:25'
export const KAVA_MAINNET = 'eip155:2222'
export const KLAYTN_MAINNET = 'eip155:8217'
// Other
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const TRON_MAINNET = 'tron:mainnet'
export const RIPPLE_MAINNET = 'xrpl:mainnet'
export const MIDNIGHT_MAINNET = 'midnight:mainnet'

// ─── Chain namespace ───────────────────────────────────────────────────────
// The `namespace` portion of a CAIP-2 string. Chains sharing a namespace share
// an HD derivation subtree (same coin type, same curve) and therefore can
// share an xpub across networks — e.g. eip155:1 and eip155:11155111 derive
// from the same HD node. This is why xpub-store keys on namespace, not ChainId.
export type ChainNamespace = 'eip155' | 'bip122' | 'cardano' | 'solana' | 'tron' | 'xrpl' | 'midnight'

/**
 * Extract the CAIP-2 namespace from a ChainId (the part before `:`).
 * Example: `getChainNamespace('eip155:8453')` → `'eip155'`.
 */
export const getChainNamespace = (chainId: ChainId): ChainNamespace => {
  const ns = chainId.slice(0, chainId.indexOf(':'))
  return ns as ChainNamespace
}
