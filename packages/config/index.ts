/**
 * @pnyx/config
 *
 * Runtime configuration for the wallet: CAIP-2 chain identifiers, the
 * feature-flag evaluation system, and remote-config fetching.
 *
 * @module
 */

// Canonical Cardano chain ids (CAIP-2) + the CIP-34 alias accepted on ingress
export {
  CARDANO_PROTOCOL_MAGIC,
  type CardanoChainId,
  type CardanoNetwork,
  cardanoChainId,
  cardanoNetworkOf,
  chainIdFromCip34,
  cip34Of,
  isCardanoChainId,
  normalizeCardanoChainId,
} from './cardano-chain-id.js'
export {valueAppliesToBuildNumber} from './feature-flag-build-number.js'
// Feature flags
export type {
  EnvironmentId,
  FeatureFlagAuditEntry,
  FeatureFlagEvaluation,
  FeatureFlagId,
  FeatureFlagSource,
  FeatureFlagsConfig,
  FeatureFlagValue,
  PlatformId,
  RuntimeOverride,
  RuntimeOverridesStorage,
} from './feature-flags.js'
export {
  CODE_DEFAULTS,
  ENVIRONMENT_OVERRIDES,
  PLATFORM_OVERRIDES,
} from './feature-flags-defaults.js'
export type {EvaluationContext} from './feature-flags-evaluation.js'
export {
  cleanExpiredOverrides,
  evaluateFeatureFlag,
  resolveFeatureFlagValue,
} from './feature-flags-evaluation.js'
export type {
  FeatureFlagListener,
  FeatureFlagsService,
  FeatureFlagsServiceOptions,
} from './feature-flags-service.js'
export {
  createFeatureFlagsService,
  createFeatureFlagsServiceLayer,
  FeatureFlagsService as FeatureFlagsServiceTag,
} from './feature-flags-service.js'
// Remote configuration
export type {
  RemoteAllowedNotificationLinks,
  RemoteBanner,
  RemoteBannerOverride,
  RemoteBannerPlatform,
  RemoteBannerSlot,
  RemoteChain,
  RemoteConfig,
  RemoteConfigEnv,
  RemoteConfigUrlOptions,
  RemoteDappConfig,
  RemoteEndpoints,
  RemoteMaintenanceConfig,
  RemoteNetworkName,
  RemoteNetworkRule,
  RemoteNetworksConfig,
  RemoteOfficialConfig,
  RemoteSwapConfig,
} from './remote-config.js'
export {
  ConfigLoadError,
  fetchRemoteConfig,
  getAllowedLinks,
  getBanners,
  getMaintenanceFlags,
  getNetworkRule,
  getNetworkRules,
  getRemoteConfigAssetUrl,
  getRemoteConfigUrl,
  getRemoteDapps,
  getRemoteFeatureFlags,
  getRemoteSwapKeyInjectedByEndpoint,
  getRemoteSwapPartnerKey,
} from './remote-config.js'
// CAIP-2 chain identifiers (prefer the named constants over raw string literals)
export {
  ARBITRUM_ONE,
  AURORA_MAINNET,
  AVALANCHE_MAINNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  BINANCE_MAINNET,
  BITCOIN_CASH_MAINNET,
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  CARDANO_PREPROD,
  CARDANO_PREVIEW,
  CELO_MAINNET,
  type ChainId,
  type ChainNamespace,
  CRONOS_MAINNET,
  DOGECOIN_MAINNET,
  ETHEREUM_MAINNET,
  FANTOM_MAINNET,
  GNOSIS_MAINNET,
  getChainNamespace,
  KAVA_MAINNET,
  KLAYTN_MAINNET,
  LINEA_MAINNET,
  LITECOIN_MAINNET,
  MANTLE_MAINNET,
  MIDNIGHT_MAINNET,
  MOONBEAM_MAINNET,
  OPTIMISM_MAINNET,
  POLYGON_MAINNET,
  RIPPLE_MAINNET,
  SCROLL_MAINNET,
  SOLANA_MAINNET,
  TRON_MAINNET,
  ZKSYNC_MAINNET,
} from './types.js'
