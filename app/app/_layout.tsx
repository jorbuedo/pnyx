/**
 * Root layout with app providers.
 *
 * NOTE: Unistyles is configured in index.js BEFORE Expo Router loads routes.
 * This is necessary because Expo Router statically imports route files,
 * which import components with StyleSheet.create((theme) => ...) calls.
 */

// Configure LogBox to not show stack traces for our logger messages
import {useFonts} from 'expo-font'
import {useNavigationContainerRef} from 'expo-router'
import {LogBox, View} from 'react-native'
import {GestureHandlerRootView} from 'react-native-gesture-handler'
import * as Sentry from '../src/logger/sentry-sdk'
import {platformIsWeb} from '../src/platform'

if (!platformIsWeb) {
  // Ignore logs from our logger (they start with ISO timestamp)
  // This prevents the stack trace overlay while still showing the message in console
  LogBox.ignoreLogs([/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, /code: -32603/, /-32603/])
}

import {loggerRegistry} from '@pnyx/logger'
import {Stack} from 'expo-router'
import {StatusBar, setStatusBarStyle} from 'expo-status-bar'
import {type FC, type ReactNode, useEffect, useMemo} from 'react'
import {KeyboardProvider} from 'react-native-keyboard-controller'
import {useUnistyles} from 'react-native-unistyles'
import {ClaimProgressBanner} from '../src/components/ClaimProgressBanner'
import {DevDbDumpButton} from '../src/components/DevDbDumpButton'
import {DmBackgroundTasks} from '../src/components/DmBackgroundTasks'
import {MaintenanceTakeover, useAppMaintenance} from '../src/components/MaintenanceTakeover'
import {TrezorPromptModals} from '../src/components/TrezorPromptModals'
import {UpdateOverlay} from '../src/components/UpdateOverlay'
import {SHOW_DEV_FLOATING_BUTTONS} from '../src/constants'
import {DeepLinkOptionsProvider} from '../src/hooks/deep-link-options'
import {useApprovalNavigation} from '../src/hooks/useApprovalNavigation'
import {useCeremonyCacheLifecycle} from '../src/hooks/useCeremonyCacheLifecycle'
import {useDappSnapshotPublisher} from '../src/hooks/useDappSnapshotPublisher'
import {useDappSubmitHost} from '../src/hooks/useDappSubmitHost'
import {useDeepLinkHandler} from '../src/hooks/useDeepLinkHandler'
import {isE2EAutoRestoreEnabled, useE2EAutoRestore} from '../src/hooks/useE2EAutoRestore'
import {ExplorerPreferenceProvider} from '../src/hooks/useExplorerPreference'
import {useExpoOTAUpdate} from '../src/hooks/useExpoOTAUpdate'
import {useExtensionSignHost} from '../src/hooks/useExtensionSignHost'
import {useFeatureFlag} from '../src/hooks/useFeatureFlag'
import {useGateDeepLinkBuffer} from '../src/hooks/useGateDeepLinkBuffer'
import {useInitPushNotifications} from '../src/hooks/useInitPushNotifications'
import {useLockScreen} from '../src/hooks/useLockScreen'
import {BackupStatusProvider} from '../src/hooks/useMnemonicBackupStatus'
import {PrivacyProvider} from '../src/hooks/usePrivacyMode'
import {envDefaultLogLevel, LogLevel, logger, sentryNavigationIntegration} from '../src/logger'
import {NoticeProvider} from '../src/notices'
import {unsubscribeFromUserTopic} from '../src/platform/notification-tools'
import {Toaster} from '../src/platform/sonner'
import {
  AuthProvider,
  AutomaticWalletOpeningProvider,
  ConfigProvider,
  CopyProvider,
  I18nProvider,
  NotificationProvider,
  NumberFormatProvider,
  PnyxSessionProvider,
  RealtimeProvider,
  ThemeProvider,
  useAuth,
  useConfig,
  useI18n,
  usePnyxSession,
  WalletProvider,
} from '../src/providers'
import {CardanoRailProvider} from '../src/providers/CardanoRailProvider'
import {DappBrowserProvider} from '../src/providers/DappBrowserProvider'
import {E2ESetupProvider} from '../src/providers/E2ESetupProvider'
import {HardwareWalletProvider} from '../src/providers/HardwareWalletProvider'
import {ProfileGate} from '../src/providers/ProfileGate'
import {flushPendingNickname} from '../src/services/nickname-flush'
import {getSharedStackScreenOptions, useIsDark} from '../src/theme'

/**
 * Bumps the logger to Debug while the `devTools` feature flag is on — the
 * same gate that exposes the Developer Tools section in Settings (default
 * true in dev builds, toggled in production via the 5-tap About gesture) —
 * so the Settings → Dev → Logs trail surfaces debug-level entries even in
 * prod builds. Reverts to the env default when the flag is toggled off.
 * Lives inside ConfigProvider so the feature-flag hook resolves.
 */
function DevToolsLogLevelSync() {
  const devToolsEnabled = useFeatureFlag('devTools')
  useEffect(() => {
    loggerRegistry.setLevel(devToolsEnabled ? LogLevel.Debug : envDefaultLogLevel)
  }, [devToolsEnabled])
  return null
}

/**
 * Finish a nickname whose row write has not landed yet.
 *
 * Onboarding records the chosen name and moves on rather than blocking a new user on a chain write,
 * so something has to complete it. Mounted inside `PnyxSessionProvider` because the write needs
 * `forumRoot` and the session's network — and *only* those, which is why it can run unprompted: a
 * nickname has no permit, so nothing here needs the vault.
 *
 * Runs when a session appears and not on a timer: a flush is one transaction, and the next
 * opportunity is the next sign-in or foreground, which is soon enough for a name that is already
 * recorded.
 */
function NicknameFlushSync() {
  const {session} = usePnyxSession()
  const forumRoot = session?.forumRoot
  const network = session?.network
  // A boolean rather than `session` in the deps below: the session object is replaced on every token
  // refresh, and re-running the flush on a refresh is not what this is for.
  const signedIn = session !== undefined
  useEffect(() => {
    // Both exits used to be silent, which made "no session yet", "it threw" and "it never ran"
    // indistinguishable — and a signed-in device that wrote no nickname looked like all three.
    if (forumRoot === undefined || network === undefined) {
      logger.debug('a nickname flush had nothing to run with', {
        origin: 'NicknameFlushSync',
        signedIn,
        hasForumRoot: forumRoot !== undefined,
        hasNetwork: network !== undefined,
      })
      return
    }
    void flushPendingNickname({forumRoot, network})
      .then((outcome) => {
        // Logged by the flush itself; this only records that the opportunity was taken, which is what
        // separates "nothing was owed" from "nothing ran".
        logger.debug('nickname flush ran', {origin: 'NicknameFlushSync', outcome})
      })
      .catch((error: unknown) => {
        // Without this the rejection is unhandled and the flush is invisible, which is how it looked
        // on device.
        logger.error('a nickname flush threw', {origin: 'NicknameFlushSync', error: String(error)})
      })
  }, [forumRoot, network, signedIn])
  return null
}

function UpdateGate({children}: React.PropsWithChildren) {
  const {isUpdating} = useExpoOTAUpdate()
  if (isUpdating) return <UpdateOverlay />
  return <>{children}</>
}

/**
 * Wallet provider wrapper, keyed on the active network so the wallet
 * service tree remounts on network switch.
 */
function PlatformWalletProvider({children}: {children: ReactNode}) {
  const {network} = useConfig()
  return <WalletProvider key={network}>{children}</WalletProvider>
}

/**
 * E2E auto-restore wrapper.
 * Automatically restores a wallet in E2E builds from env vars.
 * Blocks rendering until restore is complete to prevent race condition
 * where router navigates to onboarding before wallet is restored.
 */
function E2EAutoRestoreWrapper({children}: {children: ReactNode}) {
  const {isComplete} = useE2EAutoRestore()

  // In E2E mode, wait for auto-restore to complete before rendering
  // This prevents the router from navigating to onboarding before the wallet exists
  if (isE2EAutoRestoreEnabled() && !isComplete) {
    return null
  }

  return <>{children}</>
}

/**
 * Root navigation stack with themed headers.
 *
 * Mobile-only: the (lock) route group + `useLockScreen` own the app lock
 * (enclave-native — OS biometric prompt with device-passcode fallback).
 */
function RootStack() {
  const {theme} = useUnistyles()
  const {t} = useI18n()
  const isDark = useIsDark()
  const maintenanceActive = useAppMaintenance()
  const {hasWallets} = useAuth()
  const deepLinkOptions = useMemo(() => ({}), [])
  useLockScreen() // mobile session lock (enclave)
  useCeremonyCacheLifecycle() // evict enclave ceremony cache on background / logout
  useInitPushNotifications() // FCM push notifications

  // Unsubscribe from user-specific FCM topic when all wallets are deleted
  useEffect(() => {
    if (!hasWallets) {
      unsubscribeFromUserTopic().catch((e) => {
        logger.warn('Failed to unsubscribe from the user topic after the last wallet went', {
          origin: 'RootLayout',
          error: String(e),
        })
      })
    }
  }, [hasWallets])

  // Listen for inline approval navigation messages from background script
  useApprovalNavigation()
  // Publish the Cardano read snapshot for the background dApp router (extension-only)
  useDappSnapshotPublisher()
  // Answer the background router's submit relay (extension-only)
  useDappSubmitHost()
  // Run dApp sign requests routed from the background (extension-only)
  useExtensionSignHost()
  // Handle incoming deep links
  useDeepLinkHandler(deepLinkOptions)

  // Android doesn't always fire the native status bar update from the declarative
  // <StatusBar> component when isDark changes (e.g. stored light-mode preference
  // overrides a dark system theme after async load). Drive it imperatively too.
  useEffect(() => {
    setStatusBarStyle(isDark ? 'light' : 'dark')
  }, [isDark])

  // Global maintenance takeover — blocks the entire navigator while the
  // remote-config `maintenance.app` flag is set.
  if (maintenanceActive) {
    return (
      <DeepLinkOptionsProvider options={deepLinkOptions}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <MaintenanceTakeover />
      </DeepLinkOptionsProvider>
    )
  }

  return (
    <DeepLinkOptionsProvider options={deepLinkOptions}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={getSharedStackScreenOptions(theme)}>
        {/* Public routes — always accessible (login, onboarding, lock screen, permission tabs) */}
        <Stack.Screen name="index" options={{headerShown: false}} />
        <Stack.Screen name="deep-link" options={{headerShown: false}} />
        <Stack.Screen name="onboarding" options={{headerShown: false}} />
        <Stack.Screen name="(lock)" options={{headerShown: false, gestureEnabled: false}} />
        <Stack.Screen name="camera-permission" options={{headerShown: false}} />
        <Stack.Screen name="connect-dapp" options={{headerShown: false, presentation: 'transparentModal'}} />
        <Stack.Screen name="(legal)" options={{headerShown: false, presentation: 'modal'}} />
        <Stack.Screen name="(tabs)" options={{headerShown: false}} />
        <Stack.Screen name="browser" options={{headerShown: false}} />
        <Stack.Screen name="ui-playground" options={{headerShown: false}} />

        {/* Root screens that get the default header + back button */}
        <Stack.Screen name="settings" options={{headerShown: false}} />
        <Stack.Screen name="wallet" options={{headerShown: false}} />
        <Stack.Screen name="id" options={{headerShown: false}} />
        <Stack.Screen name="notifications" options={{title: t('common.nav.notifications')}} />
        <Stack.Screen name="scan" />
      </Stack>
    </DeepLinkOptionsProvider>
  )
}

/**
 * Constrains app content to a maximum width of 1000px and centers it.
 * On wider screens the theme background fills the extra space.
 */
function AppShell({children}: {children: ReactNode}) {
  const {theme} = useUnistyles()
  return (
    <View style={{flex: 1, backgroundColor: theme.colors.backgroundDefault, alignItems: 'center'}}>
      <View style={{flex: 1, width: '100%', maxWidth: 1000}}>{children}</View>
    </View>
  )
}

export default Sentry.wrap(function RootLayout() {
  useGateDeepLinkBuffer() // buffer links arriving while the profile gate is up (must be above ProfileGate)

  const navRef = useNavigationContainerRef()

  // Register navigation container with Sentry for screen tracking
  useEffect(() => {
    if (sentryNavigationIntegration) {
      sentryNavigationIntegration.registerNavigationContainer(navRef)
    }
  }, [navRef])

  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': require('../assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('../assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('../assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('../assets/fonts/Inter-Bold.ttf'),
  })

  logger.info('App starting', {origin: 'RootLayout'})

  if (fontError) {
    // Log so it's visible in the console — app continues with system font fallback
    // rather than blocking forever. @font-face in +html.tsx covers web anyway.
    logger.error('Font loading failed', {origin: 'RootLayout', fontError})
  }

  if (!fontsLoaded && !fontError) return null

  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <E2ESetupProvider>
        <ConfigProvider>
          <I18nProvider>
            <NumberFormatProvider>
              <ThemeProvider>
                <KeyboardProvider>
                  <UpdateGate>
                    <AppShell>
                      <DevToolsLogLevelSync />
                      {__DEV__ && SHOW_DEV_FLOATING_BUTTONS && <DevDbDumpButton />}
                      <ProfileGate>
                        <PrivacyProvider>
                          <ExplorerPreferenceProvider>
                            {/* Above the network-keyed wallet tree on purpose: the session's network is
                                the identity one from `/auth/config`, not the funds network, so a switch
                                must not throw away a valid JWT. Still inside `ProfileGate`, which keys
                                on the profile the identity belongs to. */}
                            <PnyxSessionProvider>
                              <NicknameFlushSync />
                              <RealtimeProvider>
                                <PlatformWalletProvider>
                                  <CardanoRailProvider>
                                    <E2EAutoRestoreWrapper>
                                      <AutomaticWalletOpeningProvider>
                                        <HardwareWalletProvider>
                                          <DappBrowserProvider>
                                            <BackupStatusProvider>
                                              <AuthProvider>
                                                <NoticeProvider>
                                                  <NotificationProvider>
                                                    <DmBackgroundTasks />
                                                    <CopyProvider>
                                                      {/* Above the stack: a claim outlives the screen
                                                        that started it. */}
                                                      <ClaimProgressBanner />
                                                      <RootStack />
                                                      {/* The device asks for a PIN or a pairing code from
                                                        whatever operation opened the session, not just from
                                                        the pair screen. */}
                                                      <TrezorPromptModals />
                                                      <Toaster />
                                                    </CopyProvider>
                                                  </NotificationProvider>
                                                </NoticeProvider>
                                              </AuthProvider>
                                            </BackupStatusProvider>
                                          </DappBrowserProvider>
                                        </HardwareWalletProvider>
                                      </AutomaticWalletOpeningProvider>
                                    </E2EAutoRestoreWrapper>
                                  </CardanoRailProvider>
                                </PlatformWalletProvider>
                              </RealtimeProvider>
                            </PnyxSessionProvider>
                          </ExplorerPreferenceProvider>
                        </PrivacyProvider>
                      </ProfileGate>
                    </AppShell>
                  </UpdateGate>
                </KeyboardProvider>
              </ThemeProvider>
            </NumberFormatProvider>
          </I18nProvider>
        </ConfigProvider>
      </E2ESetupProvider>
    </GestureHandlerRootView>
  )
}) as FC
