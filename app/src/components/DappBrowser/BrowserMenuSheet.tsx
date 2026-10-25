/**
 * Browser ⋮ menu bottom sheet.
 *
 * Two blocks: an icon row of page actions (back / forward / reload — the last
 * swapping to stop while the page loads — and share) and the browser preference
 * rows. Both the nav row and the page-specific rows are omitted on the start
 * page, where there is no page to navigate, share, copy or open elsewhere.
 *
 * Every nav action dismisses the sheet — the result is on the page behind it.
 * The two picker rows also dismiss first and let the parent open the picker,
 * because the shared `<Modal>` wraps RN's `Modal` and stacking two of those
 * does not present reliably on iOS.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import type {TabNavState} from '../../providers/DappBrowserProvider'
import {ChamferBackground} from '../Chamfer'
import {Modal} from '../Modal'
import {SettingsRow} from '../SettingsRow'
import {Toggle} from '../Toggle'
import {Typography} from '../Typography'
import {UniIcon, type UniIconName} from '../UniIcon'

type BrowserMenuSheetProps = {
  visible: boolean
  /** `null` while the active tab sits on the start page — hides the nav row. */
  navState: TabNavState | null
  searchEngineLabel: string
  walletIdentityLabel: string
  midnightIdentityLabel: string
  cardanoInjectionEnabled: boolean
  midnightInjectionEnabled: boolean
  desktopSite: boolean
  onClose: () => void
  onGoBack: () => void
  onGoForward: () => void
  onReload: () => void
  onStop: () => void
  onShare: () => void
  onCopyUrl: () => void
  /** Opens a fresh tab and closes the sheet — the switcher's `+` without the detour through it. */
  onNewTab: () => void
  /**
   * `true` when the page in the active tab is already starred.
   *
   * ⚠️ `null` on the start page, where there is no page to star — the row is hidden rather than
   * shown doing nothing.
   */
  isPageFavourite: boolean | null
  onTogglePageFavourite: () => void
  onOpenExternally: () => void
  onOpenSearchEnginePicker: () => void
  onOpenWalletIdentityPicker: () => void
  onOpenMidnightIdentityPicker: () => void
  onToggleCardanoInjection: (enabled: boolean) => void
  onToggleMidnightInjection: (enabled: boolean) => void
  onToggleDesktopSite: (enabled: boolean) => void
}

export const BrowserMenuSheet = ({
  visible,
  navState,
  searchEngineLabel,
  walletIdentityLabel,
  midnightIdentityLabel,
  cardanoInjectionEnabled,
  midnightInjectionEnabled,
  desktopSite,
  onClose,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  onShare,
  onCopyUrl,
  onNewTab,
  isPageFavourite,
  onTogglePageFavourite,
  onOpenExternally,
  onOpenSearchEnginePicker,
  onOpenWalletIdentityPicker,
  onOpenMidnightIdentityPicker,
  onToggleCardanoInjection,
  onToggleMidnightInjection,
  onToggleDesktopSite,
}: BrowserMenuSheetProps) => {
  const {t} = useI18n()

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('browser.menu.title')}
      showDragIndicator
      contentContainerStyle={styles.modalContent}
      testID="browser-menu-sheet"
    >
      {navState !== null && (
        <View style={styles.navRow}>
          {/* ⚠️ Never disabled while a page is loaded. The WebView's history may be empty, but the
              tab began on the start page and that is always somewhere to go back to — the screen's
              handler falls through to it. */}
          <NavButton
            icon="arrowLeft"
            label={t('browser.backA11y')}
            disabled={false}
            onPress={onGoBack}
            testID="browser-menu-back"
          />
          <NavButton
            icon="arrowRight"
            label={t('browser.forwardA11y')}
            disabled={!navState.canGoForward}
            onPress={onGoForward}
            testID="browser-menu-forward"
          />
          {navState.loading ? (
            <NavButton
              icon="close"
              label={t('browser.stopA11y')}
              disabled={false}
              onPress={onStop}
              testID="browser-menu-stop"
            />
          ) : (
            <NavButton
              icon="refresh"
              label={t('browser.reloadA11y')}
              disabled={false}
              onPress={onReload}
              testID="browser-menu-reload"
            />
          )}
          <NavButton
            icon="share"
            label={t('browser.share.title')}
            disabled={false}
            onPress={onShare}
            testID="browser-menu-share"
          />
          <NavButton
            icon="plus"
            label={t('browser.tabs.newTabA11y')}
            disabled={false}
            onPress={onNewTab}
            testID="browser-menu-new-tab"
          />
        </View>
      )}

      {navState !== null && (
        <>
          <SettingsRow
            label={t('browser.settings.copyUrl')}
            leftIcon="copy"
            onPress={onCopyUrl}
            showBorder
            testID="browser-menu-copy-url"
          />

          {isPageFavourite === null ? null : (
            <SettingsRow
              label={t(isPageFavourite ? 'browser.unfavourite' : 'browser.favourite')}
              description={t('browser.favouriteSubtitle')}
              leftIcon={isPageFavourite ? 'starFilled' : 'star'}
              onPress={onTogglePageFavourite}
              showBorder
              testID="browser-menu-favourite"
            />
          )}

          <SettingsRow
            label={t('browser.settings.openExternally')}
            description={t('browser.settings.openExternallySubtitle')}
            leftIcon="globe"
            onPress={onOpenExternally}
            showBorder
            testID="browser-menu-open-externally"
          />

          <SettingsRow
            label={t('browser.settings.desktopSite')}
            description={t('browser.settings.desktopSiteSubtitle')}
            testID="browser-menu-desktop-site"
          >
            <Toggle checked={desktopSite} onChange={onToggleDesktopSite} testID="browser-menu-desktop-site-toggle" />
          </SettingsRow>
        </>
      )}

      <SettingsRow
        label={t('browser.settings.searchEngine')}
        onPress={onOpenSearchEnginePicker}
        showBorder
        testID="browser-menu-search-engine"
      >
        <RowValue value={searchEngineLabel} />
      </SettingsRow>

      <SettingsRow
        label={t('browser.settings.showAs')}
        description={t('browser.settings.showAsSubtitle')}
        onPress={onOpenWalletIdentityPicker}
        showBorder
        testID="browser-menu-show-as"
      >
        <RowValue value={walletIdentityLabel} />
      </SettingsRow>

      <SettingsRow
        label={t('browser.settings.cardanoInjection')}
        description={t('browser.settings.cardanoInjectionSubtitle')}
        showBorder
        testID="browser-menu-cardano-injection"
      >
        <Toggle
          checked={cardanoInjectionEnabled}
          onChange={onToggleCardanoInjection}
          testID="browser-menu-cardano-injection-toggle"
        />
      </SettingsRow>

      <SettingsRow
        label={t('browser.settings.showAsMidnight')}
        description={t('browser.settings.showAsMidnightSubtitle')}
        onPress={onOpenMidnightIdentityPicker}
        showBorder
        testID="browser-menu-show-as-midnight"
      >
        <RowValue value={midnightIdentityLabel} />
      </SettingsRow>

      <SettingsRow
        label={t('browser.settings.midnightInjection')}
        description={t('browser.settings.midnightInjectionSubtitle')}
        testID="browser-menu-midnight-injection"
      >
        <Toggle
          checked={midnightInjectionEnabled}
          onChange={onToggleMidnightInjection}
          testID="browser-menu-midnight-injection-toggle"
        />
      </SettingsRow>
    </Modal>
  )
}

const RowValue = ({value}: {value: string}) => (
  <View style={styles.rowRight}>
    <Typography variant="bodyMd_regular" style={styles.rowValue}>
      {value}
    </Typography>
    <UniIcon name="chevronRight" size="xs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
  </View>
)

const NavButton = ({
  icon,
  label,
  disabled,
  onPress,
  testID,
}: {
  icon: UniIconName
  label: string
  disabled: boolean
  onPress: () => void
  testID: string
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    style={({pressed}) => [styles.navButton, disabled && styles.navButtonDisabled, pressed && styles.navButtonPressed]}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{disabled}}
    testID={testID}
  >
    <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" borderWidth={1} />
    <UniIcon
      name={icon}
      size="md"
      uniProps={(theme) => ({color: disabled ? theme.colors.textMuted : theme.colors.textDefault})}
    />
  </Pressable>
)

const styles = StyleSheet.create(({colors, spacing}) => ({
  modalContent: {
    paddingTop: spacing.spacing4,
  },
  navRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-around' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing16,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  navButton: {
    width: 48,
    height: 48,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  navButtonPressed: {
    opacity: 0.6,
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  rowRight: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing8,
  },
  rowValue: {
    color: colors.textAlternative,
  },
}))
