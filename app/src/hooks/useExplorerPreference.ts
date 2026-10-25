/**
 * Explorer preference context and hook.
 *
 * One React context so every consumer shares the state, and so an explorer link
 * is always built for the **active network** — callers used to pass a network in
 * and one of them hardcoded "not mainnet means preprod", which was wrong the
 * moment preview became selectable. Wrap the app with
 * `<ExplorerPreferenceProvider>` and consume via `useExplorerPreference()`.
 *
 * @module
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {useConfig} from '../providers/ConfigProvider'
import {assetFingerprint} from '../services/cardano-assets/asset-fingerprint'
import {assetIdToUnit} from '../services/cardano-assets/asset-id'
import {
  buildExplorerUrl,
  DEFAULT_EXPLORER_ID,
  type ExplorerId,
  type ExplorerNetwork,
  type ExplorerUrlType,
  getNetworkBaseUrl,
  getTokenIdForm,
  parseExplorerId,
} from './explorerConfig'

export type {ExplorerId, ExplorerUrlType} from './explorerConfig'
// Re-export the pure helpers so existing consumers don't need to change imports.
export {getExplorerDomain, getExplorerName} from './explorerConfig'

/** Storage key for the explorer preference. */
const EXPLORER_PREFERENCE_KEY = '@pnyx/explorer_preference'

export type ExplorerPreference = {
  /** Currently selected explorer. */
  readonly explorerId: ExplorerId
  /** Set the preferred explorer. */
  readonly setExplorerId: (id: ExplorerId) => void
  /** Build a URL on the selected explorer for the active network. */
  readonly getExplorerUrl: (type: ExplorerUrlType, value: string) => string
  /**
   * Token-page URL for an app asset id, in whichever identifier form the selected
   * explorer expects. `null` for ADA and for a malformed id — a caller must then
   * omit the link rather than open a 404.
   */
  readonly getTokenUrl: (assetId: string) => string | null
  /** Base URL of the selected explorer for the active network. */
  readonly getBaseUrl: () => string
}

const defaultValue: ExplorerPreference = {
  explorerId: DEFAULT_EXPLORER_ID,
  setExplorerId: () => {},
  getExplorerUrl: (type, value) => buildExplorerUrl(DEFAULT_EXPLORER_ID, type, value, 'mainnet'),
  getTokenUrl: () => null,
  getBaseUrl: () => getNetworkBaseUrl(DEFAULT_EXPLORER_ID, 'mainnet'),
}

export const ExplorerPreferenceContext = createContext<ExplorerPreference>(defaultValue)

/** Shares the explorer preference across all consumers. */
export const ExplorerPreferenceProvider = ({children}: {children: ReactNode}) => {
  const {network} = useConfig()
  const [explorerId, setExplorerIdState] = useState<ExplorerId>(DEFAULT_EXPLORER_ID)

  useEffect(() => {
    const loadPreference = async () => {
      try {
        const stored = parseExplorerId(await storage.get(EXPLORER_PREFERENCE_KEY))
        if (stored !== null) setExplorerIdState(stored)
      } catch (e: unknown) {
        // Keeping the default is right — but a user who chose an explorer sees it revert, and
        // "never chose one" and "could not read the choice" look identical on screen.
        logger.warn('Explorer preference unreadable; keeping the default', {
          origin: 'useExplorerPreference',
          error: String(e),
        })
      }
    }
    loadPreference()
  }, [])

  const setExplorerId = useCallback(async (id: ExplorerId) => {
    setExplorerIdState(id)
    try {
      await storage.set(EXPLORER_PREFERENCE_KEY, id)
    } catch (e: unknown) {
      logger.warn('Explorer preference not persisted; it applies for this session only', {
        origin: 'useExplorerPreference',
        explorerId: id,
        error: String(e),
      })
    }
  }, [])

  // The app network is named after the Cardano networks, which is exactly what
  // the explorers subdomain on — no mapping needed.
  const explorerNetwork: ExplorerNetwork = network

  const getExplorerUrl = useCallback(
    (type: ExplorerUrlType, value: string): string => buildExplorerUrl(explorerId, type, value, explorerNetwork),
    [explorerId, explorerNetwork],
  )

  const getTokenUrl = useCallback(
    (assetId: string): string | null => {
      const value = getTokenIdForm(explorerId) === 'unit' ? assetIdToUnit(assetId) : assetFingerprint(assetId)
      if (value === null || value.length === 0) return null
      return buildExplorerUrl(explorerId, 'token', value, explorerNetwork)
    },
    [explorerId, explorerNetwork],
  )

  const getBaseUrl = useCallback(
    (): string => getNetworkBaseUrl(explorerId, explorerNetwork),
    [explorerId, explorerNetwork],
  )

  const contextValue = useMemo(
    () => ({explorerId, setExplorerId, getExplorerUrl, getTokenUrl, getBaseUrl}),
    [explorerId, setExplorerId, getExplorerUrl, getTokenUrl, getBaseUrl],
  )

  return createElement(ExplorerPreferenceContext.Provider, {value: contextValue}, children)
}

/**
 * Access the shared explorer preference.
 *
 * Must be used within an `<ExplorerPreferenceProvider>`.
 *
 * @example
 * ```tsx
 * const {explorerId, setExplorerId, getExplorerUrl} = useExplorerPreference()
 * const txUrl = getExplorerUrl('tx', txHash)
 * ```
 */
export const useExplorerPreference = (): ExplorerPreference => useContext(ExplorerPreferenceContext)
