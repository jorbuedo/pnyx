/**
 * Browser top bar.
 *
 *   ‹ back | ✕ close page | URL pill | tabs button + count | ⋮ menu
 *
 * Back arrow exits the Browser surface entirely (matches the v1 X close
 * behaviour). The ✕ beside it is the smaller step: it drops the page and
 * returns to the dApp list, keeping the tab. It is only rendered while a page
 * is open, since on the start page there is nothing to close and a dead
 * control next to a live one is worse than no control.
 * The URL pill is tappable as a whole — opens the full-screen
 * search overlay. Leading icon is dynamic: shield in success colour for
 * HTTPS, search glyph otherwise. Trailing affordance inside the pill is
 * refresh / stop, swapped by load state.
 *
 * The ⋮ button opens `BrowserMenuSheet` — page navigation controls plus the
 * browser preferences. Reload is duplicated here in the URL pill (trailing
 * icon, swaps with stop while loading) since it is the one control worth a
 * single tap; Android hardware back walks WebView history.
 *
 * A thin progress bar is pinned to the bottom edge of the bar while the
 * active tab is loading — replaces the absolute spinner from the v1 chrome.
 *
 * @module
 */

import {Platform, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import type {TabNavState} from '../../providers/DappBrowserProvider'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'
import {LoadingProgressBar} from './LoadingProgressBar'

type BrowserTopBarProps = {
  inputUrl: string
  currentUrl: string | null
  navState: TabNavState
  tabCount: number
  onBack: () => void
  /** Drop the current page and show the dApp list. Only rendered while a page is open. */
  onClosePage: () => void
  onUrlPress: () => void
  onUrlLongPress: () => void
  onOpenTabs: () => void
  onOpenMenu: () => void
  onRefresh: () => void
  onStop: () => void
}

export const BrowserTopBar = ({
  inputUrl,
  currentUrl,
  navState,
  tabCount,
  onBack,
  onClosePage,
  onUrlPress,
  onUrlLongPress,
  onOpenTabs,
  onOpenMenu,
  onRefresh,
  onStop,
}: BrowserTopBarProps) => {
  const {t} = useI18n()

  const isSecure = currentUrl?.startsWith('https://') ?? false
  const showTrailing = currentUrl !== null
  const displayText = inputUrl || t('browser.urlPlaceholder')
  const isPlaceholder = !inputUrl

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Plain chevron — matches canonical HeaderBackButton style used across
            the app. The circular variant is non-canonical (per design review). */}
        <Pressable
          onPress={onBack}
          style={({pressed}) => [styles.backButton, pressed && styles.backButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel={t('browser.backBrowserA11y')}
          hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
        >
          <UniIcon name="chevronLeft" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
        </Pressable>

        {currentUrl !== null && (
          <Pressable
            onPress={onClosePage}
            style={({pressed}) => [styles.backButton, pressed && styles.backButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel={t('browser.closePageA11y')}
            hitSlop={{top: 16, bottom: 16, left: 8, right: 8}}
            testID="browser-close-page"
          >
            <UniIcon name="close" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
          </Pressable>
        )}

        <Pressable
          onPress={onUrlPress}
          onLongPress={currentUrl ? onUrlLongPress : undefined}
          style={styles.urlPill}
          accessibilityRole="button"
          accessibilityLabel={isSecure ? t('browser.secureA11y') : t('browser.insecureA11y')}
        >
          <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" />
          <UniIcon
            name={isSecure ? 'shieldCheck' : 'search'}
            size="xxs"
            uniProps={(theme) => ({
              color: isSecure ? theme.colors.successDefault : theme.colors.textAlternative,
            })}
          />
          <Typography
            variant="bodySm_regular"
            style={isPlaceholder ? styles.urlTextPlaceholder : styles.urlText}
            numberOfLines={1}
          >
            {displayText}
          </Typography>
          {showTrailing &&
            (navState.loading ? (
              <Pressable
                onPress={onStop}
                style={styles.urlTrailing}
                accessibilityRole="button"
                accessibilityLabel={t('browser.stopA11y')}
                hitSlop={6}
              >
                <UniIcon name="close" size="xxs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
              </Pressable>
            ) : (
              <Pressable
                onPress={onRefresh}
                style={styles.urlTrailing}
                accessibilityRole="button"
                accessibilityLabel={t('browser.reloadA11y')}
                hitSlop={6}
              >
                <UniIcon name="refresh" size="xxs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
              </Pressable>
            ))}
        </Pressable>

        <Pressable
          onPress={onOpenTabs}
          style={styles.roundButton}
          accessibilityRole="button"
          accessibilityLabel={t('browser.openTabsA11y')}
          hitSlop={6}
        >
          <View style={styles.tabsBadge}>
            <ChamferBackground size={4} borderToken="textDefault" borderWidth={1.5} />
            <Typography variant="bodyXs_medium" style={styles.tabsCount}>
              {tabCount}
            </Typography>
          </View>
        </Pressable>

        <Pressable
          onPress={onOpenMenu}
          style={styles.iconOnlyButton}
          accessibilityRole="button"
          accessibilityLabel={t('browser.moreA11y')}
          hitSlop={6}
        >
          <UniIcon name="moreVertical" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
        </Pressable>
      </View>

      <LoadingProgressBar visible={navState.loading} />
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing, textVariants}) => ({
  container: {
    backgroundColor: colors.backgroundNavigation,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
    gap: spacing.spacing8,
  },
  roundButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.backgroundAlternative,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // Mirrors HeaderBackButton — plain chevron, 5px padding, hit-slop handles the
  // touch target. No background or border, so it matches Settings / other
  // root-stack back arrows across the app.
  backButton: {
    padding: 5,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  backButtonPressed: {
    opacity: 0.6,
  },
  iconOnlyButton: {
    width: 36,
    height: 36,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  tabsBadge: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsCount: {
    color: colors.textDefault,
    fontSize: 10,
    lineHeight: 12,
  },
  urlPill: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
    gap: spacing.spacing8,
    overflow: 'hidden' as const,
  },
  urlText: {
    flex: 1,
    minWidth: 0,
    color: colors.textDefault,
    ...(Platform.OS === 'web' ? ({textAlign: 'left' as const} as const) : {}),
    fontSize: textVariants.bodySm_regular.fontSize,
    fontFamily: textVariants.bodySm_regular.fontFamily,
  },
  urlTextPlaceholder: {
    flex: 1,
    minWidth: 0,
    color: colors.textAlternative,
    fontSize: textVariants.bodySm_regular.fontSize,
    fontFamily: textVariants.bodySm_regular.fontFamily,
  },
  urlTrailing: {
    padding: spacing.spacing4,
  },
}))
