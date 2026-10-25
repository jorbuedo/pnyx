/**
 * Tabs switcher overlay.
 *
 * Full-screen list of open tabs. Header layout:
 *   ← back · "Tabs" + count subtitle · + new tab
 *
 * Each tab card shows favicon + title + close × in the header row, and
 * a captured WebView snapshot in the body (or a domain-coloured fallback
 * when no snapshot is available yet).
 *
 * Selecting a card switches the active tab and closes the overlay.
 * Closing the last tab spawns a fresh start-page tab in its place
 * (handled by `closeTab` in the provider).
 *
 * @module
 */

import {Image, Modal, Pressable, ScrollView, View} from 'react-native'
import Animated, {FadeInDown} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import type {BrowserTab} from '../../providers/DappBrowserProvider'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'

type TabsSwitcherProps = {
  visible: boolean
  tabs: readonly BrowserTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTab: () => void
  onDismiss: () => void
}

const tabTitle = (tab: BrowserTab, fallback: string): string => {
  if (tab.navState.title) return tab.navState.title
  if (tab.currentUrl) {
    try {
      return new URL(tab.currentUrl).hostname
    } catch (e: unknown) {
      logger.debug('Tab URL is not parseable; labelling the tab with the raw string', {
        origin: 'TabsSwitcher',
        error: String(e),
      })
      return tab.currentUrl
    }
  }
  return fallback
}

const faviconUrl = (currentUrl: string | null): string | null => {
  if (!currentUrl) return null
  try {
    const origin = new URL(currentUrl).origin
    return `${origin}/favicon.ico`
  } catch (e: unknown) {
    logger.debug('Tab URL is not parseable; the tab shows no favicon', {
      origin: 'TabsSwitcher',
      error: String(e),
    })
    return null
  }
}

export const TabsSwitcher = ({
  visible,
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNewTab,
  onDismiss,
}: TabsSwitcherProps) => {
  const {t} = useI18n()
  const newTabFallback = t('browser.tabs.newTabTitle')
  const countSubtitle = t('browser.tabs.count', {count: tabs.length})

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="overFullScreen" onRequestClose={onDismiss}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            onPress={onDismiss}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel={t('browser.tabs.backA11y')}
            hitSlop={6}
          >
            <UniIcon name="chevronLeft" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
          </Pressable>
          <View style={styles.headerTitleBlock}>
            <Typography variant="bodyMd_bold">{t('browser.tabs.title')}</Typography>
            <Typography variant="bodySm_regular" style={styles.headerCount}>
              {countSubtitle}
            </Typography>
          </View>
          <Pressable
            onPress={onNewTab}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel={t('browser.tabs.newTabA11y')}
            hitSlop={6}
          >
            <UniIcon name="plus" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.list}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const favicon = faviconUrl(tab.currentUrl)
            return (
              <Animated.View key={tab.id} entering={FadeInDown.duration(280).springify().damping(18)}>
                <Pressable onPress={() => onSelect(tab.id)} accessibilityRole="button">
                  {/* Only the top corner is cut: the thumbnail is a full-bleed rectangle on
                      the bottom edge, and no paint layer can clip an image to a bevel. */}
                  <ChamferBackground
                    size="auto"
                    cut="topRight"
                    fillToken="backgroundLayer1"
                    borderToken={isActive ? 'primaryDefault' : 'borderDefaultWeak'}
                    borderWidth={1}
                  />
                  <View style={styles.cardHeader}>
                    {favicon ? (
                      <Image source={{uri: favicon}} style={styles.favicon} />
                    ) : (
                      <View style={styles.faviconFallback}>
                        <ChamferBackground size={4} fillToken="backgroundAlternative" />
                      </View>
                    )}
                    <Typography variant="bodySm_medium" numberOfLines={1} style={styles.cardTitle}>
                      {tabTitle(tab, newTabFallback)}
                    </Typography>
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation()
                        onClose(tab.id)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={t('browser.tabs.closeTabA11y')}
                      hitSlop={6}
                      style={styles.cardCloseButton}
                    >
                      <UniIcon name="close" size="xxs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
                    </Pressable>
                  </View>
                  <View style={styles.cardThumb}>
                    {tab.thumbnailUri ? (
                      <Image source={{uri: tab.thumbnailUri}} style={styles.cardThumbImage} resizeMode="cover" />
                    ) : favicon ? (
                      <Image source={{uri: favicon}} style={styles.cardThumbFavicon} resizeMode="contain" />
                    ) : null}
                  </View>
                </Pressable>
              </Animated.View>
            )
          })}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}, rt) => ({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundDefault,
    paddingTop: rt.insets.top,
    paddingBottom: rt.insets.bottom,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing12,
    gap: spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  headerIconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleBlock: {
    flex: 1,
    alignItems: 'center' as const,
  },
  headerCount: {
    color: colors.textAlternative,
  },
  list: {
    padding: spacing.spacing16,
    gap: spacing.spacing12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
    gap: spacing.spacing8,
  },
  favicon: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  faviconFallback: {
    width: 16,
    height: 16,
  },
  cardTitle: {
    flex: 1,
    minWidth: 0,
    color: colors.textDefault,
  },
  cardCloseButton: {
    padding: spacing.spacing4,
  },
  cardThumb: {
    aspectRatio: 16 / 9,
    backgroundColor: colors.backgroundAlternative,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  },
  cardThumbImage: {
    width: '100%' as const,
    height: '100%' as const,
  },
  cardThumbFavicon: {
    width: 36,
    height: 36,
    opacity: 0.5,
  },
}))
