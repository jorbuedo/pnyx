/**
 * Pure explorer configuration and URL-building utilities.
 *
 * Separated from the React context (useExplorerPreference) so these functions
 * can be tested without pulling in React Native.
 *
 * Paths were verified against each explorer with real ids (2026-07-25) — they
 * are not guesses and they are not uniform: AdaStat pluralises every segment
 * and serves stake addresses from `/addresses/`, Cardanoscan uses `/stakeKey/`,
 * Cexplorer uses `/asset/` where the others say token. Every explorer here
 * covers every link type the app emits, so a preference can never leave a link
 * unopenable.
 *
 * `tokenIdForm` was verified by hand (2026-07-26) — the bot protection makes it
 * unautomatable, so a human opened both forms on each explorer. **Every explorer
 * accepts both**, so no link can break either way; the form is chosen to match each
 * explorer's own canonical URL and avoid a redirect: Cexplorer canonicalises to the
 * CIP-14 fingerprint, AdaStat canonicalises to the `policyId+assetNameHex` unit, and
 * Cardanoscan serves both without redirecting (fingerprint kept there — it needs no
 * indexer and is computed locally).
 *
 * @module
 */

/** Supported Cardano explorer identifiers. */
export type ExplorerId = 'cardanoscan' | 'cexplorer' | 'adastat'

/** The kinds of thing the app links out to. */
export type ExplorerUrlType = 'tx' | 'address' | 'stake' | 'pool' | 'token' | 'drep' | 'block'

/**
 * Cardano explorer network name. All three explorers host testnets on a
 * subdomain of the same domain (`preprod.cardanoscan.io`, `preview.adastat.net`).
 */
export type ExplorerNetwork = 'mainnet' | 'preprod' | 'preview'

/**
 * Which identifier an explorer's token page expects. Both name the same asset:
 * `fingerprint` is CIP-14 `asset1…`, `unit` is `policyId + assetNameHex`.
 */
export type TokenIdForm = 'fingerprint' | 'unit'

type ExplorerUrlConfig = {
  readonly id: ExplorerId
  readonly name: string
  readonly baseUrl: string
  /** Path segment per link type, e.g. `tx: '/transaction/'`. */
  readonly paths: Record<ExplorerUrlType, string>
  /** The form this explorer's `token` path takes. */
  readonly tokenIdForm: TokenIdForm
}

/** Explorer configurations with URL templates, in picker order. */
export const EXPLORER_CONFIGS: Record<ExplorerId, ExplorerUrlConfig> = {
  cardanoscan: {
    id: 'cardanoscan',
    name: 'Cardanoscan',
    baseUrl: 'https://cardanoscan.io',
    paths: {
      tx: '/transaction/',
      address: '/address/',
      stake: '/stakeKey/',
      pool: '/pool/',
      token: '/token/',
      drep: '/drep/',
      block: '/block/',
    },
    tokenIdForm: 'fingerprint',
  },
  cexplorer: {
    id: 'cexplorer',
    name: 'Cexplorer',
    baseUrl: 'https://cexplorer.io',
    paths: {
      tx: '/tx/',
      address: '/address/',
      stake: '/stake/',
      pool: '/pool/',
      token: '/asset/',
      drep: '/drep/',
      block: '/block/',
    },
    tokenIdForm: 'fingerprint',
  },
  adastat: {
    id: 'adastat',
    name: 'AdaStat',
    baseUrl: 'https://adastat.net',
    paths: {
      tx: '/transactions/',
      address: '/addresses/',
      // AdaStat resolves reward addresses through the same `/addresses/` route.
      stake: '/addresses/',
      pool: '/pools/',
      token: '/tokens/',
      drep: '/dreps/',
      block: '/blocks/',
    },
    // AdaStat canonicalises a token page to the unit; a fingerprint reaches the
    // same page via a redirect (verified by hand 2026-07-26).
    tokenIdForm: 'unit',
  },
}

/** Every explorer id, in the order the picker lists them. */
export const EXPLORER_IDS: readonly ExplorerId[] = ['cardanoscan', 'cexplorer', 'adastat']

/** The default when the user has no stored preference. */
export const DEFAULT_EXPLORER_ID: ExplorerId = 'cardanoscan'

/** Narrow an arbitrary stored value to an explorer id, or `null` if unknown. */
export const parseExplorerId = (value: string | null | undefined): ExplorerId | null =>
  EXPLORER_IDS.includes(value as ExplorerId) ? (value as ExplorerId) : null

/**
 * Canonical mainnet address explorers for the non-Cardano derive-only chains
 * (BTC / EVM / SOL have no in-app explorer preference — one canonical site
 * each). User-facing browser deep-links, not app data sources; targets
 * approved by the dev lead 2026-07-18.
 */
export const DERIVE_ONLY_ADDRESS_EXPLORERS: Record<
  'bitcoin' | 'evm' | 'solana',
  {readonly name: string; readonly addressUrl: string}
> = {
  bitcoin: {name: 'Mempool', addressUrl: 'https://mempool.space/address/'},
  evm: {name: 'Etherscan', addressUrl: 'https://etherscan.io/address/'},
  solana: {name: 'Solscan', addressUrl: 'https://solscan.io/account/'},
}

/** Network-aware base URL for an explorer (testnets live on a subdomain). */
export const getNetworkBaseUrl = (explorerId: ExplorerId, network: ExplorerNetwork): string => {
  const config = EXPLORER_CONFIGS[explorerId]
  if (network === 'mainnet') return config.baseUrl
  return config.baseUrl.replace('https://', `https://${network}.`)
}

/** Display name for an explorer. */
export const getExplorerName = (explorerId: ExplorerId): string => EXPLORER_CONFIGS[explorerId].name

/** Domain (e.g. "cardanoscan.io") for an explorer, for use as a sublabel. */
export const getExplorerDomain = (explorerId: ExplorerId): string =>
  EXPLORER_CONFIGS[explorerId].baseUrl.replace('https://', '')

/** The token-page identifier form for an explorer. */
export const getTokenIdForm = (explorerId: ExplorerId): TokenIdForm => EXPLORER_CONFIGS[explorerId].tokenIdForm

/** Build a network-aware explorer URL. */
export const buildExplorerUrl = (
  explorerId: ExplorerId,
  type: ExplorerUrlType,
  value: string,
  network: ExplorerNetwork,
): string => `${getNetworkBaseUrl(explorerId, network)}${EXPLORER_CONFIGS[explorerId].paths[type]}${value}`
