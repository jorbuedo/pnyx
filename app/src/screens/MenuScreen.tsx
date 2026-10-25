/**
 * Menu tab — the settings hub plus the account actions moved off the former
 * Profile screen (backup, passkey recovery, sign out).
 *
 * Grouped by topic, most consequential first: ACCOUNT & SECURITY · WALLETS ·
 * CONNECTIONS · PREFERENCES · NETWORK · ASSISTANT · ABOUT · Developer Tools
 * (flag-gated) · Sign out. Rows had been appended wherever they fit as features
 * landed, which put the recovery phrase and the number format in the same reach.
 *
 * **Two things were removed rather than moved (2026-08-13).** The Support row
 * pointed at an external help centre that does not exist — support happens in the
 * community — and the About screen held only a version and two legal links, so it
 * is flattened into the ABOUT group. Its 5-tap dev-mode gesture came with it: see
 * the note on the version row.
 *
 * The settings detail screens still live under `/settings/*` and are pushed over
 * the tabs; only the hub itself moved here (docs/mobile-shell-plan.md phase 6,
 * product/STATUS.md nav reshape). `/settings` (bare) redirects to this tab.
 *
 * @module
 */

import Constants from 'expo-constants'
import {router, useFocusEffect} from 'expo-router'
import {useCallback} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {DevModeToggle} from '../components/DevModeToggle'
import {reloadApp} from '../components/dev-actions'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {SettingsGroup} from '../components/SettingsGroup'
import {SettingsRow} from '../components/SettingsRow'
import {Tag} from '../components/Tag'
import {Typography} from '../components/Typography'
import {UniIcon, type UniIconName} from '../components/UniIcon'
import {getExplorerName, useExplorerPreference} from '../hooks/useExplorerPreference'
import {useFeatureFlag} from '../hooks/useFeatureFlag'
import {useHasMultisigWallets} from '../hooks/useHasMultisigWallets'
import {useNotificationPermissions} from '../hooks/useNotificationPermissions'
import {SUPPORTED_LOCALES} from '../i18n'
import {useLegalAgreement} from '../legal'
import {NoticeDot} from '../notices'
import {isExtension, isNative} from '../platform'
import {type NumberFormatPreference, useConfig, useI18n, useNumberFormat, usePnyxSession, useTheme} from '../providers'
import {isPasskeyRecoveryAvailable} from '../services/passkey-recovery'
import {getNetworkDisplayName} from '../utils/network-utils'
import {DEV_TOOLS_ROWS} from './dev-tools-rows'

export function MenuScreen() {
  const {t, locale} = useI18n()
  const {identity, signOut} = usePnyxSession()

  const isProdEnv = Constants.expoConfig?.extra?.appEnv === 'prod'
  const devToolsEnabled = useFeatureFlag('devTools') && !isProdEnv
  const pushNotificationsEnabled = useFeatureFlag('pushNotifications')
  const showNotifications = isNative && pushNotificationsEnabled
  const {network, currency} = useConfig()
  const {themeMode} = useTheme()
  const {preference: numberFormatPreference} = useNumberFormat()
  const {explorerId} = useExplorerPreference()
  const {acceptedAt: tosAcceptedAt, expire: expireTosAgreement} = useLegalAgreement()
  const passkeySupported = isPasskeyRecoveryAvailable()
  const version = Constants.expoConfig?.version ?? ''
  const hasMultisig = useHasMultisigWallets()

  const {refreshStatus} = useNotificationPermissions()

  const handleExpireTos = useCallback(async () => {
    await expireTosAgreement()
    reloadApp()
  }, [expireTosAgreement])

  useFocusEffect(
    useCallback(() => {
      if (!isNative) return
      refreshStatus()
    }, [refreshStatus]),
  )

  const chevron = (
    <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
  )

  const themeLabel =
    themeMode === 'dark'
      ? t('settings.appearance.dark')
      : themeMode === 'light'
        ? t('settings.appearance.light')
        : t('settings.theme.system')
  const currentLanguageName = SUPPORTED_LOCALES[locale as keyof typeof SUPPORTED_LOCALES]?.nativeName ?? locale
  const numberFormatLabel = numberFormatPreferenceLabel(numberFormatPreference, t)

  const renderValue = (value: string) => (
    <View style={styles.valueRow}>
      <Typography variant="bodyMd_regular" style={styles.valueText}>
        {value}
      </Typography>
      {chevron}
    </View>
  )

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={[]}
      scrollable
      hasBottomMenu
      contentContainerStyle={styles.scrollContent}
    >
      {/* ACCOUNT & SECURITY — the identity itself comes first: the recovery phrase is the only
          thing here that cannot be re-derived, and everything below protects it. */}
      {/* CONNECTIONS — everything that reaches outside the app: the browser, what it has let in, and
          the people this wallet keeps. */}
      <SettingsGroup label={t('settings.hub.sections.connections')}>
        {isNative ? (
          <SettingsRow
            label={t('menu.browser')}
            leftIcon="tabBrowser"
            iconColor="textMuted"
            onPress={() => router.push({pathname: '/browser', params: {from: 'settings'}})}
            testID="menu-browser"
            size="lg"
          >
            {chevron}
          </SettingsRow>
        ) : null}
        <SettingsRow
          label={t('settings.connectedDapps.title')}
          description={t('settings.connectedDapps.rowDescription')}
          leftIcon="globe"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/connected-dapps')}
          testID="menu-connected-dapps"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('contacts.title')}
          description={t('contacts.rowDescription')}
          leftIcon="community"
          iconColor="textMuted"
          onPress={() => router.navigate('/wallet/contacts')}
          testID="menu-contacts"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        {isExtension ? (
          <SettingsRow
            label={t('settings.protocolLinks.title')}
            description={t('settings.protocolLinks.rowDescription')}
            leftIcon="link"
            iconColor="textMuted"
            onPress={() => router.navigate('/settings/protocol-links')}
            testID="menu-protocol-links"
            size="lg"
          >
            {chevron}
          </SettingsRow>
        ) : null}
        <SettingsRow
          label={t('settings.network.rowTitle')}
          leftIcon="chain"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/network')}
          testID="menu-network"
          size="lg"
        >
          {renderValue(getNetworkDisplayName(network, false))}
        </SettingsRow>
        <SettingsRow
          label={t('settings.endpoints.rowTitle')}
          description={t('settings.endpoints.rowDescription')}
          leftIcon="settings"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/endpoints')}
          testID="menu-endpoints"
          size="lg"
        >
          {chevron}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('settings.hub.sections.account')}>
        <SettingsRow
          label={t('settings.security.title')}
          leftIcon="lock"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/security')}
          testID="menu-security"
          size="lg"
        >
          <View style={styles.trailingRow}>
            <NoticeDot route="/settings/security" position="static" />
            {chevron}
          </View>
        </SettingsRow>
        {identity !== undefined && passkeySupported && (
          <SettingsRow
            label={t('passkeyRecovery.setupRow')}
            description={t('passkeyRecovery.setupRowDescription')}
            leftIcon="shieldCheck"
            iconColor="textMuted"
            onPress={() => router.push('/settings/passkey-recovery')}
            testID="menu-passkey-recovery"
            size="lg"
          >
            {chevron}
          </SettingsRow>
        )}
        <SettingsRow
          label={t('you.identityRecoveryPhrase')}
          description={t('you.identityRecoveryPhraseDescription')}
          leftIcon="backUp"
          iconColor="textMuted"
          onPress={() =>
            router.push({pathname: '/settings/recovery-phrase-warn', params: {identity: 'true', showOnly: 'true'}})
          }
          testID="menu-identity-backup"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('settings.signingAudit.title')}
          description={t('settings.signingAudit.rowDescription')}
          leftIcon="lock"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/signing-history')}
          testID="menu-signing-history"
          size="lg"
        >
          {chevron}
        </SettingsRow>
      </SettingsGroup>

      {/* PREFERENCES — how the app presents itself. Nothing here changes what a key can do. */}
      <SettingsGroup label={t('settings.hub.sections.preferences')}>
        {showNotifications ? (
          <SettingsRow
            label={t('settings.hub.notifications')}
            leftIcon="notification"
            iconColor="textMuted"
            onPress={() => router.navigate('/settings/notifications')}
            testID="menu-notifications"
            size="lg"
          >
            <View style={styles.trailingRow}>
              <NoticeDot route="/settings/notifications" position="static" />
              {chevron}
            </View>
          </SettingsRow>
        ) : null}
        <SettingsRow
          label={t('settings.messaging.title')}
          leftIcon="chat"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/messaging')}
          testID="menu-messaging"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('settings.theme.title')}
          leftIcon={themeIcon(themeMode)}
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/theme')}
          testID="menu-theme"
          size="lg"
        >
          {renderValue(themeLabel)}
        </SettingsRow>
        <SettingsRow
          label={t('settings.language.title')}
          leftIcon="language"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/language')}
          testID="menu-language"
          size="lg"
        >
          {renderValue(currentLanguageName)}
        </SettingsRow>
        <SettingsRow
          label={t('settings.currency.title')}
          leftIcon="currency"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/currency')}
          testID="menu-currency"
          size="lg"
        >
          {renderValue(currency)}
        </SettingsRow>
        <SettingsRow
          label={t('settings.numberFormat.title')}
          leftIcon="hash"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/number-format')}
          testID="menu-number-format"
          size="lg"
        >
          {renderValue(numberFormatLabel)}
        </SettingsRow>
      </SettingsGroup>

      {/* NETWORK — which chain the app is talking to, and where it sends you to look. Separate from
          Preferences because these change what the app *reads*, not how it looks. */}

      {/* WALLETS — shared wallets and the things done to a wallet rather than to the identity. */}
      <SettingsGroup label={t('settings.hub.sections.cardanoWallets')}>
        <SettingsRow
          label={t('multisig.list.title')}
          leftIcon="wallet"
          iconColor="textMuted"
          onPress={() => router.push('/wallet/shared-wallets' as never)}
          testID="menu-shared-wallets"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        {hasMultisig ? (
          <SettingsRow
            label={t('cosign.title')}
            leftIcon="pending"
            iconColor="textMuted"
            onPress={() => router.push('/wallet/cosign' as never)}
            testID="menu-cosign"
            size="lg"
          >
            {chevron}
          </SettingsRow>
        ) : null}
        <SettingsRow
          label={t('settings.walletOptimization.title')}
          description={t('settings.walletOptimization.rowDescription')}
          leftIcon="settings"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/wallet-optimization')}
          testID="menu-wallet-optimization"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('settings.explorer.blockchainExplorer')}
          leftIcon="blockExplorer"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/explorer')}
          testID="menu-explorer"
          size="lg"
        >
          {renderValue(getExplorerName(explorerId))}
        </SettingsRow>
      </SettingsGroup>

      {/* ASSISTANT — its own group rather than a stray row in Preferences: it is the one feature here
          that can be wrong about facts, which the row says out loud. */}
      <SettingsGroup label={t('settings.hub.sections.assistant')}>
        <SettingsRow
          label={t('aiSettings.title')}
          description={t('aiSettings.rowDescription')}
          leftIcon="lightbulb"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/ai')}
          testID="menu-ai"
          size="lg"
        >
          {/* The model gets facts wrong in ways prompt rules do not reliably prevent, so
              the entry point says so rather than leaving the user to discover it. */}
          <View style={styles.trailingRow}>
            <Tag size="sm" label={t('aiSettings.experimental')} variant="warning" testID="menu-ai-experimental" />
            {chevron}
          </View>
        </SettingsRow>
        {/* Beside the on-device model because both are "the assistant", and apart from the dApp rows
            under Connections because this is not a connection the user browsed to. ⚠️ The two are
            opposite trust stories — that one never leaves the phone, this one hands data to somebody
            else's software — which is why they do not share a namespace or a description. */}
        <SettingsRow
          label={t('agents.title')}
          description={t('agents.rowDescription')}
          leftIcon="lightbulb"
          iconColor="textMuted"
          onPress={() => router.navigate('/settings/agents')}
          testID="menu-agents"
          size="lg"
        >
          {chevron}
        </SettingsRow>
      </SettingsGroup>

      {/* ABOUT — flattened out of its own screen, which held exactly these three things.
          The version row carries the 5-tap dev-mode gesture it used to carry there; it is the only
          way to turn developer tools on, so it moves with the version rather than being dropped. */}
      <SettingsGroup label={t('settings.hub.sections.about')}>
        <View style={styles.versionRow}>
          {/* ⚠️ The one row that still carries its own `showBorder`. `SettingsGroup` gives dividers to
              its direct `SettingsRow` children, and this one is wrapped in the relative-positioned
              View that anchors the dev-mode toggle — so the group cannot see it and it has to say so
              itself. */}
          <SettingsRow
            label={t('settings.about.version')}
            leftIcon="pnyxLogo"
            iconColor="logoPrimary"
            testID="menu-version"
            size="lg"
            showBorder
          >
            <Typography variant="bodyMd_regular" style={styles.valueText}>
              {version}
            </Typography>
          </SettingsRow>
          <DevModeToggle testID="menu-dev-mode-toggle" />
        </View>
        {/* Under ABOUT rather than a section of its own: a bug report is about the app itself,
            and it belongs beside the version the reporter will be asked for. */}
        <SettingsRow
          label={t('bugReport.title')}
          leftIcon="warning"
          iconColor="textMuted"
          onPress={() => router.push('/settings/bug-report')}
          testID="menu-bug-report"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('settings.about.termsConditions')}
          leftIcon="fileText"
          iconColor="textMuted"
          onPress={() => router.navigate('/(legal)/terms-of-service')}
          testID="menu-terms"
          size="lg"
        >
          {chevron}
        </SettingsRow>
        <SettingsRow
          label={t('settings.about.privacyPolicy')}
          leftIcon="security"
          iconColor="textMuted"
          onPress={() => router.navigate('/(legal)/privacy-policy')}
          testID="menu-privacy"
          size="lg"
        >
          {chevron}
        </SettingsRow>
      </SettingsGroup>

      {/* Developer Tools — gated on `devTools` flag (toggled via the 5-tap DevModeToggle) */}
      {devToolsEnabled && (
        <SettingsGroup label={t('settings.developer.title')}>
          {DEV_TOOLS_ROWS.map((row) => (
            <SettingsRow
              key={row.route}
              testID={row.testID}
              onPress={() => router.navigate(row.route as never)}
              label={row.text.kind === 'key' ? t(row.text.label) : row.text.label}
              description={
                row.text.description === undefined
                  ? undefined
                  : row.text.kind === 'key'
                    ? t(row.text.description)
                    : row.text.description
              }
            >
              {chevron}
            </SettingsRow>
          ))}
          <SettingsRow
            testID="tos-acceptance-row"
            label={t('settings.developer.tosRowLabel')}
            description={
              tosAcceptedAt != null
                ? t('settings.developer.tosRowAccepted', {date: new Date(tosAcceptedAt).toLocaleString()})
                : t('settings.developer.tosRowNotAccepted')
            }
          >
            <Typography
              variant="bodySm_medium"
              style={styles.tosRepromptText}
              onPress={handleExpireTos}
              testID="tos-acceptance-reprompt"
            >
              {t('settings.developer.tosRowReprompt')}
            </Typography>
          </SettingsRow>
        </SettingsGroup>
      )}

      {/* SIGN OUT */}
      {identity !== undefined && (
        <SettingsGroup>
          <SettingsRow
            label={t('you.signOut')}
            description={t('you.signOutDescription')}
            leftIcon="lock"
            destructive
            onPress={signOut}
            testID="menu-sign-out"
          />
        </SettingsGroup>
      )}
    </SafeAreaViewWrapper>
  )
}

function themeIcon(mode: 'system' | 'light' | 'dark'): UniIconName {
  if (mode === 'light') return 'lightMode'
  if (mode === 'dark') return 'nightMode'
  return 'systemDefaultTheme'
}

function numberFormatPreferenceLabel(pref: NumberFormatPreference, t: ReturnType<typeof useI18n>['t']): string {
  switch (pref) {
    case 'auto':
      return t('settings.numberFormat.autoLabel')
    case 'us':
      return '1,234.56'
    case 'eu':
      return '1.234,56'
    case 'fr':
      return '1 234,56'
    case 'ch':
      return "1'234.56"
  }
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  // Positioned parent for `DevModeToggle`, which is an absolute-fill tap overlay.
  versionRow: {position: 'relative'},
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    gap: spacing.spacing24,
  },
  trailingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing8,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing8,
  },
  valueText: {
    color: colors.textAlternative,
  },
  tosRepromptText: {
    color: colors.errorDefault,
  },
}))
