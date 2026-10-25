/**
 * Configuration provider.
 *
 * Provides app-wide configuration state: network selection (a global setting
 * that affects all wallets), feature flags, remote config, and currency.
 * The chain roster is hardcoded (`services/chains.ts`) — there is no
 * user-facing chain enable/disable.
 *
 * @module
 */

import type {
  ChainId,
  RemoteAllowedNotificationLinks,
  RemoteBanner,
  RemoteBannerPlatform,
  RemoteConfig,
  RemoteDappConfig,
  RemoteMaintenanceConfig,
} from '@pnyx/config'
import {
  createFeatureFlagsService,
  type EnvironmentId,
  type FeatureFlagsService,
  fetchRemoteConfig,
  getAllowedLinks,
  getBanners,
  getMaintenanceFlags,
  getNetworkRules,
  getRemoteConfigUrl,
  getRemoteDapps,
  getRemoteFeatureFlags,
  getRemoteSwapKeyInjectedByEndpoint,
  getRemoteSwapPartnerKey,
  type PlatformId,
  type RemoteConfigEnv,
} from '@pnyx/config'
import type {Network} from '@pnyx/wallet'
import {Effect} from 'effect'
import * as Application from 'expo-application'
import Constants from 'expo-constants'
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import {remoteCardanoSwapApi} from '../config/chain-availability'
import {DEFAULT_NETWORK, parseStoredNetwork} from '../config/networks'
import {logger} from '../logger'
import {isExtension, isNative, platformIsAndroid, platformIsIOS, platformIsWeb} from '../platform'
import {getOrCreateInstallationId} from '../platform/installation-id'
import {deviceStorage as storage} from '../platform/storage'
import {setAllowedLinks} from '../services/allowed-links'
import {setActiveCardanoNetwork} from '../services/cardano/config'
import {
  setRemoteSteelswapKeyInjected,
  setRemoteSteelswapPartnerKey,
  setRemoteSteelswapUrl,
} from '../services/cardano-assets/config'
import {FUNDS_CHAINS} from '../services/chains'
import {setRemoteNetworkRules} from '../services/midnight/endpoint-overrides'
import {loadEndpointOverrides} from '../services/midnight/endpoint-overrides-store'
import {FIAT_CURRENCY_CODES, type FiatCurrency} from './fiat-currencies'
import {resolveDeviceCurrency} from './resolve-device-currency'

const NETWORK_STORAGE_KEY = '@pnyx/network'
const CURRENCY_STORAGE_KEY = '@pnyx/currency'

export type {FiatCurrency} from './fiat-currencies'

const REMOTE_CONFIG_STALE_MS = 5 * 60 * 1000 // 5 minutes
const REMOTE_CONFIG_CACHE_KEY = '@pnyx/remote-config-cache'

export type ConfigContextValue = {
  readonly network: Network
  readonly setNetwork: (network: Network) => Promise<void>
  readonly isNetworkLoading: boolean
  /** The wallet service's live chains — hardcoded (identity wallet = Midnight only). */
  readonly enabledChains: readonly ChainId[]
  /** Feature flags service (undefined while initializing) */
  readonly featureFlagsService: FeatureFlagsService | undefined
  /** Whether feature flags service is still loading */
  readonly isFeatureFlagsLoading: boolean
  /** Selected fiat currency for balance display */
  readonly currency: FiatCurrency
  /** Set the fiat currency preference */
  readonly setCurrency: (currency: FiatCurrency) => Promise<void>
  /** Whether currency preference is still loading */
  readonly isCurrencyLoading: boolean
}

export type RemoteConfigContextValue = {
  /** Remote config data (undefined while loading or on error) */
  readonly remoteConfig: RemoteConfig | undefined
  /** Whether the remote config is currently being fetched */
  readonly isLoading: boolean
  /** Maintenance flags for features and chains */
  readonly maintenance: RemoteMaintenanceConfig | undefined
  /** Active banners filtered by date range */
  readonly banners: ReadonlyArray<RemoteBanner>
  /** DApps configuration for discovery browser */
  readonly dapps: RemoteDappConfig | undefined
  /** Allowed deep links from push notifications */
  readonly allowedLinks: RemoteAllowedNotificationLinks | undefined
}

export const ConfigContext = createContext<ConfigContextValue | null>(null)
export const RemoteConfigContext = createContext<RemoteConfigContextValue | null>(null)

export type ConfigProviderProps = {
  children: ReactNode
}

/**
 * Detect platform ID based on runtime environment.
 */
const parseBuildNumber = (raw: string | null): number => {
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

const detectPlatform = (): PlatformId => {
  if (isNative) {
    return 'mobile'
  }
  if (platformIsWeb) {
    if (isExtension) {
      return 'extension'
    }
    return 'web'
  }
  // Fallback
  return 'web'
}

const detectBannerPlatform = (): RemoteBannerPlatform => {
  if (platformIsIOS) return 'ios'
  if (platformIsAndroid) return 'android'
  if (isExtension) return 'extension'
  return 'web'
}

export function ConfigProvider({children}: ConfigProviderProps) {
  const [network, setNetworkState] = useState<Network>(DEFAULT_NETWORK)
  const [isNetworkLoading, setIsNetworkLoading] = useState(true)
  const [featureFlagsService, setFeatureFlagsService] = useState<FeatureFlagsService | undefined>(undefined)
  const [isFeatureFlagsLoading, setIsFeatureFlagsLoading] = useState(true)
  const [currency, setCurrencyState] = useState<FiatCurrency>(() => resolveDeviceCurrency())
  const [isCurrencyLoading, setIsCurrencyLoading] = useState(true)

  const appEnv = useMemo(() => (Constants.expoConfig?.extra?.appEnv ?? 'prod') as RemoteConfigEnv, [])

  // One layer per build variant. `preview` used to be folded into `production` so it would not
  // inherit development's blanket-enable; it now has its own layer, which is just as minimal, so a
  // feature can be on in the test build and off in the shipped one without that trade.
  //
  // ⚠️ Keyed on `appEnv`, not `isDev`: a preview build sets `buildVariant='prod'` (so it is
  // prod-shaped) while `appEnv` stays `'preview'`, and only the latter tells the two apart.
  const flagsEnvironment = useMemo<EnvironmentId>(
    () => (appEnv === 'dev' ? 'development' : appEnv === 'preview' ? 'preview' : 'production'),
    [appEnv],
  )

  const platform = useMemo(() => detectPlatform(), [])
  const bannerPlatform = useMemo(() => detectBannerPlatform(), [])

  // -- Feature flags service initialization ------------------------------------

  useEffect(() => {
    const initFeatureFlags = async () => {
      try {
        const installationId = await getOrCreateInstallationId()

        // Create storage adapter matching the service's expected API
        const storageAdapter = {
          getItem: (key: string) => storage.get(key),
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.remove(key),
        }

        // Create service directly
        const service = await Effect.runPromise(
          createFeatureFlagsService({
            platform,
            environment: flagsEnvironment,
            installationId,
            // `nativeBuildVersion` is `CFBundleVersion` on iOS and `versionCode`
            // on Android — both monotonic ints (encoded as a string here).
            // Falls back to `0` when null (Expo Go / dev runs); the evaluator
            // treats `<= 0` as "unknown" and the build-number gate fails open.
            buildNumber: parseBuildNumber(Application.nativeBuildVersion),
            storage: storageAdapter,
            remoteConfig: undefined, // Will be updated when remote config loads
          }),
        )

        setFeatureFlagsService(service)
        logger.info('Feature flags service initialized', {
          origin: 'ConfigProvider',
          platform,
          flagsEnvironment,
          installationId,
        })
      } catch (e) {
        logger.error('Failed to initialize feature flags service', {origin: 'ConfigProvider', error: e})
      } finally {
        setIsFeatureFlagsLoading(false)
      }
    }

    initFeatureFlags()
  }, [platform, flagsEnvironment])

  // -- Remote config ---------------------------------------------------------

  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | undefined>(undefined)
  const [isRemoteConfigLoading, setIsRemoteConfigLoading] = useState(true)
  const remoteConfigTimestampRef = useRef(0)
  const remoteConfigRef = useRef<RemoteConfig | undefined>(undefined)

  useEffect(() => {
    remoteConfigRef.current = remoteConfig
  }, [remoteConfig])

  useEffect(() => {
    let mounted = true

    const loadRemoteConfig = async () => {
      try {
        const cached = await storage.get(REMOTE_CONFIG_CACHE_KEY)
        if (mounted && cached && !remoteConfigRef.current) {
          const parsed = JSON.parse(cached) as RemoteConfig
          setRemoteConfig(parsed)
          logger.debug('Remote config served from cache (revalidating)', {origin: 'ConfigProvider', appEnv})
        }
      } catch (e) {
        logger.warn('Failed to load cached remote config', {origin: 'ConfigProvider', error: e})
      }

      // Skip if fetched recently (stale-while-revalidate)
      if (Date.now() - remoteConfigTimestampRef.current < REMOTE_CONFIG_STALE_MS) {
        setIsRemoteConfigLoading(false)
        return
      }

      try {
        const url = getRemoteConfigUrl({env: appEnv})
        const config = await Effect.runPromise(fetchRemoteConfig(url))
        if (mounted) {
          setRemoteConfig(config)
          remoteConfigTimestampRef.current = Date.now()
          storage.set(REMOTE_CONFIG_CACHE_KEY, JSON.stringify(config)).catch((error) => {
            logger.warn('Failed to cache remote config', {origin: 'ConfigProvider', error})
          })
          logger.info('Remote config loaded', {
            origin: 'ConfigProvider',
            appEnv,
            url,
            // What actually came back, not just that something did. A fetch that
            // logs success while returning a stale or wrong file is otherwise
            // indistinguishable from one that worked.
            dapps: config.dapps?.recommended?.length ?? 0,
            banners: config.banners?.length ?? 0,
          })
        }
      } catch (e) {
        logger.warn('Failed to fetch remote config, using cached/fallback', {origin: 'ConfigProvider', error: e})
      } finally {
        if (mounted) setIsRemoteConfigLoading(false)
      }
    }

    loadRemoteConfig()

    return () => {
      mounted = false
    }
  }, [appEnv])

  // Publish the current allowedLinks record to the shared module cache so
  // code outside React context (push-notification background handlers,
  // notifee setup, etc.) can synchronously check whether an outgoing link
  // is allowlisted. Clears to undefined when remote config isn't yet
  // loaded — that's the safest default: the helper rejects all external
  // links when the record is missing.
  useEffect(() => {
    setAllowedLinks(getAllowedLinks(remoteConfig))
  }, [remoteConfig])

  // Publish the per-chain, per-network rules to the module-level registry that `networks.ts` reads.
  // That lookup is synchronous and runs from places React never reaches (sync workers, submit
  // paths), so the rules cannot live in context alone.
  //
  // Clearing to `undefined` while remote config is absent is deliberate: no rules means "use the
  // built-in endpoints, every network available". A failed fetch must not be able to leave a
  // network switched off with no way to switch it back on.
  useEffect(() => {
    const rules = getNetworkRules(remoteConfig)
    setRemoteNetworkRules(rules)
    // The SteelSwap base rides the same matrix. It is published here rather than next to the other
    // Cardano config because it is the one Cardano endpoint the fleet has to be able to move
    // mid-release: it is how the embedded partner key is retired for a key-holding proxy.
    setRemoteSteelswapUrl(remoteCardanoSwapApi(rules))
  }, [remoteConfig])

  // The SteelSwap partner key, which is what attributes a swap's fee to Pnyx rather than to the
  // user's own auto-provisioned account. Published here on dev and preview instead of compiled in.
  //
  // ⚠️ Clearing to `undefined` when remote config is absent is deliberate and has a cost: a swap in
  // that window authenticates with the per-install CIP-8 key, which works and pays the fee to the
  // wrong principal. The alternative — holding a stale key — would keep authenticating against a
  // credential the control plane may have just revoked, which fails louder but no more correctly.
  useEffect(() => {
    setRemoteSteelswapPartnerKey(getRemoteSwapPartnerKey(remoteConfig))
    // Published alongside the key, and it is what lets the key stop being published at all: with
    // this set the app sends no credential and the endpoint supplies one. Defaults to false when
    // remote config is absent, which keeps the app acquiring its own rather than sending none to
    // an API that requires one.
    setRemoteSteelswapKeyInjected(getRemoteSwapKeyInjectedByEndpoint(remoteConfig))
  }, [remoteConfig])

  // Load this device's own endpoint overrides once. They outrank the control plane, so a device
  // that has been pointed somewhere keeps pointing there even while remote config is still in
  // flight — which is the state the app is in for the first seconds of every launch.
  useEffect(() => {
    loadEndpointOverrides().catch((error) =>
      logger.warn('endpoint overrides failed to load', {origin: 'ConfigProvider', error: String(error)}),
    )
  }, [])

  // Apply remote feature flags when both remote config and feature flags service are available
  useEffect(() => {
    if (!remoteConfig || !featureFlagsService) return

    const mergedFeatureFlags = getRemoteFeatureFlags(remoteConfig)
    if (!mergedFeatureFlags) return

    let mounted = true

    Effect.runPromise(featureFlagsService.updateRemoteConfig(mergedFeatureFlags))
      .then(() => {
        if (mounted) logger.info('Remote feature flags applied', {origin: 'ConfigProvider'})
      })
      .catch((e) => {
        if (mounted) logger.warn('Failed to apply remote feature flags', {origin: 'ConfigProvider', error: e})
      })

    return () => {
      mounted = false
    }
  }, [remoteConfig, featureFlagsService])

  const remoteConfigValue = useMemo<RemoteConfigContextValue>(
    () => ({
      remoteConfig,
      isLoading: isRemoteConfigLoading,
      maintenance: getMaintenanceFlags(remoteConfig),
      banners: getBanners(remoteConfig, bannerPlatform),
      dapps: getRemoteDapps(remoteConfig),
      allowedLinks: getAllowedLinks(remoteConfig),
    }),
    [remoteConfig, isRemoteConfigLoading, bannerPlatform],
  )

  // Load persisted network on mount
  useEffect(() => {
    const loadNetwork = async () => {
      try {
        const storedNetwork = parseStoredNetwork(await storage.get(NETWORK_STORAGE_KEY))
        if (storedNetwork !== null) {
          // Point the rail before the state lands, so the first render that sees
          // the new network also sees a matching `getCardanoRailConfig()`.
          setActiveCardanoNetwork(storedNetwork)
          setNetworkState(storedNetwork)
          logger.info('Loaded persisted network', {origin: 'ConfigProvider', network: storedNetwork})
        }
      } catch (e) {
        logger.warn('Failed to load persisted network', {origin: 'ConfigProvider', error: e})
      } finally {
        setIsNetworkLoading(false)
      }
    }
    loadNetwork()
  }, [])

  // Load persisted currency on mount
  useEffect(() => {
    const loadCurrency = async () => {
      try {
        const storedCurrency = await storage.get(CURRENCY_STORAGE_KEY)
        if (storedCurrency && (FIAT_CURRENCY_CODES as readonly string[]).includes(storedCurrency)) {
          setCurrencyState(storedCurrency as FiatCurrency)
          logger.info('Loaded persisted currency', {origin: 'ConfigProvider', currency: storedCurrency})
        }
      } catch (e) {
        logger.warn('Failed to load persisted currency', {origin: 'ConfigProvider', error: e})
      } finally {
        setIsCurrencyLoading(false)
      }
    }
    loadCurrency()
  }, [])

  // Set currency and persist
  const setCurrency = useCallback(async (newCurrency: FiatCurrency) => {
    try {
      await storage.set(CURRENCY_STORAGE_KEY, newCurrency)
      setCurrencyState(newCurrency)
      logger.info('Currency changed', {origin: 'ConfigProvider', currency: newCurrency})
    } catch (e) {
      logger.error('Failed to persist currency', {origin: 'ConfigProvider', error: e})
      throw new Error('Failed to save currency setting')
    }
  }, [])

  // Set network and persist
  const setNetwork = useCallback(async (newNetwork: Network) => {
    try {
      await storage.set(NETWORK_STORAGE_KEY, newNetwork)
      setActiveCardanoNetwork(newNetwork)
      setNetworkState(newNetwork)
      logger.info('Network changed', {origin: 'ConfigProvider', network: newNetwork})
    } catch (e) {
      logger.error('Failed to persist network', {origin: 'ConfigProvider', error: e})
      throw new Error('Failed to save network setting')
    }
  }, [])

  const value = useMemo<ConfigContextValue>(() => {
    return {
      network,
      setNetwork,
      isNetworkLoading,
      enabledChains: FUNDS_CHAINS,
      featureFlagsService,
      isFeatureFlagsLoading,
      currency,
      setCurrency,
      isCurrencyLoading,
    }
  }, [
    network,
    setNetwork,
    isNetworkLoading,
    featureFlagsService,
    isFeatureFlagsLoading,
    currency,
    setCurrency,
    isCurrencyLoading,
  ])

  return (
    <ConfigContext.Provider value={value}>
      <RemoteConfigContext.Provider value={remoteConfigValue}>{children}</RemoteConfigContext.Provider>
    </ConfigContext.Provider>
  )
}

export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider')
  }
  return context
}

export function useRemoteConfig(): RemoteConfigContextValue {
  const context = useContext(RemoteConfigContext)
  if (!context) {
    throw new Error('useRemoteConfig must be used within a ConfigProvider')
  }
  return context
}
