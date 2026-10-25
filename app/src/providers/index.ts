/**
 * Providers for the wallet app.
 *
 * @module
 */

export {AuthProvider, type AuthProviderProps, useAuth} from './AuthProvider'
export {
  AutomaticWalletOpeningContext,
  type AutomaticWalletOpeningContextValue,
  AutomaticWalletOpeningProvider,
  type AutomaticWalletOpeningProviderProps,
} from './AutomaticWalletOpeningProvider'
export {
  ConfigContext,
  type ConfigContextValue,
  ConfigProvider,
  type ConfigProviderProps,
  RemoteConfigContext,
  type RemoteConfigContextValue,
  useConfig,
  useRemoteConfig,
} from './ConfigProvider'
export {CopyProvider, useCopy} from './CopyProvider'
export {
  DappBrowserProvider,
  type DappBrowserProviderProps,
  useDappBrowserState,
} from './DappBrowserProvider'
export {
  I18nContext,
  type I18nContextValue,
  I18nProvider,
  type I18nProviderProps,
  type LocaleCode,
  useI18n,
} from './I18nProvider'
export {NotificationProvider, usePushNotificationManager} from './NotificationProvider'
export {
  NUMBER_FORMAT_PREFERENCES,
  type NumberFormatContextValue,
  type NumberFormatPreference,
  NumberFormatProvider,
  type NumberFormatProviderProps,
  useFormat,
  useFormatCrypto,
  useFormatFiat,
  useFormatPercent,
  useNumberFormat,
  useNumberLocale,
  useNumberParser,
} from './NumberFormatProvider'
export {OnboardingProvider, useOnboarding} from './OnboardingProvider'
export {PnyxSessionProvider, usePnyxSession} from './PnyxSessionProvider'
export {RealtimeProvider, useRealtime} from './RealtimeProvider'
export {
  ThemeContext,
  type ThemeContextValue,
  type ThemeMode,
  ThemeProvider,
  type ThemeProviderProps,
  useTheme,
} from './ThemeProvider'
export {
  type CreateWalletParams,
  type IndexedAddress,
  // Specialized hooks for optimal performance
  useWalletAddress,
  useWalletBalance,
  useWalletCore,
  useWalletData,
  useWalletList,
  useWalletSync,
  // Contexts (for advanced use cases)
  WalletAddressContext,
  type WalletAddressContextValue,
  WalletBalanceContext,
  type WalletBalanceContextValue,
  WalletCoreContext,
  type WalletCoreContextValue,
  WalletDataContext,
  type WalletDataContextValue,
  type WalletGroup,
  type WalletGroupView,
  WalletListContext,
  type WalletListContextValue,
  WalletProvider,
  type WalletProviderProps,
  WalletSyncContext,
  type WalletSyncContextValue,
} from './WalletProvider'
