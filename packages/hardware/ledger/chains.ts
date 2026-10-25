/**
 * Ledger chain support and app mapping.
 *
 * Maps blockchain chains to their corresponding Ledger app names and provides
 * utilities for grouping chains by app for app-switching wizards.
 *
 * @module
 */

import {
  ARBITRUM_ONE,
  AURORA_MAINNET,
  AVALANCHE_MAINNET,
  BASE_MAINNET,
  BINANCE_MAINNET,
  BITCOIN_CASH_MAINNET,
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  CELO_MAINNET,
  type ChainId,
  CRONOS_MAINNET,
  DOGECOIN_MAINNET,
  ETHEREUM_MAINNET,
  FANTOM_MAINNET,
  GNOSIS_MAINNET,
  KLAYTN_MAINNET,
  LINEA_MAINNET,
  LITECOIN_MAINNET,
  MANTLE_MAINNET,
  MOONBEAM_MAINNET,
  OPTIMISM_MAINNET,
  POLYGON_MAINNET,
  SCROLL_MAINNET,
  SOLANA_MAINNET,
  TRON_MAINNET,
  ZKSYNC_MAINNET,
} from '@pnyx/config'

/**
 * Ledger app icon type.
 */
export type LedgerAppIcon = 'cardano' | 'bitcoin' | 'ethereum' | 'solana' | 'tron'

/**
 * Information about a Ledger app and its supported chains.
 */
export type LedgerAppInfo = {
  /** Internal app identifier */
  readonly id: string
  /** Display name as shown on Ledger device */
  readonly appName: string
  /** Chains supported by this app */
  readonly chains: readonly ChainId[]
  /** App icon identifier for UI */
  readonly icon: LedgerAppIcon
}

/**
 * Ledger apps and their supported chains.
 *
 * Each Ledger device can only have one app open at a time.
 * Users must manually switch apps when importing multiple chains.
 */
export const LEDGER_APPS: Record<string, LedgerAppInfo> = {
  cardano: {
    id: 'cardano',
    appName: 'Cardano ADA',
    chains: [CARDANO_MAINNET] as const,
    icon: 'cardano',
  },
  bitcoin: {
    id: 'bitcoin',
    appName: 'Bitcoin',
    chains: [BITCOIN_MAINNET, LITECOIN_MAINNET, DOGECOIN_MAINNET, BITCOIN_CASH_MAINNET] as const,
    icon: 'bitcoin',
  },
  ethereum: {
    id: 'ethereum',
    appName: 'Ethereum',
    chains: [
      ETHEREUM_MAINNET,
      POLYGON_MAINNET,
      ARBITRUM_ONE,
      OPTIMISM_MAINNET,
      AVALANCHE_MAINNET,
      BASE_MAINNET,
      FANTOM_MAINNET,
      GNOSIS_MAINNET,
      LINEA_MAINNET,
      SCROLL_MAINNET,
      ZKSYNC_MAINNET,
      MANTLE_MAINNET,
      CELO_MAINNET,
      MOONBEAM_MAINNET,
      AURORA_MAINNET,
      CRONOS_MAINNET,
      KLAYTN_MAINNET,
      BINANCE_MAINNET,
    ] as const,
    icon: 'ethereum',
  },
  solana: {
    id: 'solana',
    appName: 'Solana',
    chains: [SOLANA_MAINNET] as const,
    icon: 'solana',
  },
  tron: {
    id: 'tron',
    appName: 'Tron',
    chains: [TRON_MAINNET] as const,
    icon: 'tron',
  },
} as const

/**
 * All chains supported by Ledger devices.
 */
export const SUPPORTED_CHAINS: readonly ChainId[] = Object.values(LEDGER_APPS).flatMap((app) => app.chains)

/**
 * Get the Ledger app for a specific chain.
 *
 * @param chainId - The chain identifier
 * @returns The Ledger app info, or undefined if not supported
 *
 * @example
 * ```ts
 * const app = getAppForChain(CARDANO_MAINNET)
 * // { id: 'cardano', appName: 'Cardano ADA', chains: [CARDANO_MAINNET], icon: 'cardano' }
 *
 * const ethApp = getAppForChain(POLYGON_MAINNET)
 * // { id: 'ethereum', appName: 'Ethereum', chains: [...], icon: 'ethereum' }
 * ```
 */
export const getAppForChain = (chainId: ChainId): LedgerAppInfo | undefined => {
  for (const app of Object.values(LEDGER_APPS)) {
    if ((app.chains as readonly string[]).includes(chainId)) {
      return app
    }
  }
  return undefined
}

/**
 * Get the Ledger app ID for a chain.
 *
 * @param chainId - The chain identifier
 * @returns The Ledger app ID, or undefined if not supported
 */
export const getAppIdForChain = (chainId: ChainId): string | undefined => {
  return getAppForChain(chainId)?.id
}

/**
 * Check if a chain is supported by Ledger.
 *
 * @param chainId - The chain identifier
 * @returns True if the chain is supported
 */
export const isChainSupported = (chainId: ChainId): boolean => {
  return getAppForChain(chainId) !== undefined
}

/**
 * Group selected chains by their Ledger app.
 *
 * Used to determine the app-switching order during import.
 *
 * @param selectedChains - Array of selected chain IDs
 * @returns Array of app infos with the chains that need that app, preserving order
 *
 * @example
 * ```ts
 * const groups = groupChainsByApp([CARDANO_MAINNET, POLYGON_MAINNET, ETHEREUM_MAINNET, BITCOIN_MAINNET])
 * // [
 * //   { appInfo: { id: 'cardano', ... }, selectedChains: [CARDANO_MAINNET] },
 * //   { appInfo: { id: 'ethereum', ... }, selectedChains: [POLYGON_MAINNET, ETHEREUM_MAINNET] },
 * //   { appInfo: { id: 'bitcoin', ... }, selectedChains: [BITCOIN_MAINNET] },
 * // ]
 * ```
 */
export const groupChainsByApp = (
  selectedChains: readonly ChainId[],
): readonly {readonly appInfo: LedgerAppInfo; readonly selectedChains: readonly ChainId[]}[] => {
  const appGroups = new Map<string, {appInfo: LedgerAppInfo; selectedChains: ChainId[]}>()
  const appOrder: string[] = []

  for (const chainId of selectedChains) {
    const app = getAppForChain(chainId)
    if (!app) continue

    const existing = appGroups.get(app.id)
    if (existing) {
      existing.selectedChains.push(chainId)
    } else {
      appGroups.set(app.id, {appInfo: app, selectedChains: [chainId]})
      appOrder.push(app.id)
    }
  }

  return appOrder
    .map((appId) => appGroups.get(appId))
    .filter((group): group is {appInfo: LedgerAppInfo; selectedChains: ChainId[]} => group !== undefined)
    .map((group) => ({
      appInfo: group.appInfo,
      selectedChains: group.selectedChains as readonly ChainId[],
    }))
}
