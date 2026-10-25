/**
 * Bottom tab shell — Id · Community · Wallets · Menu.
 *
 * The Phase-3 Discord layout (rail + channel panel + chat push-stack) lives inside
 * the Community tab; the former bottom `UserBar` is replaced by the tab bar, and its
 * identicon + bell move to the shared `AppTopBar` rendered as the navigator header.
 * See docs/mobile-shell-plan.md phase 6 and product/STATUS.md (nav reshape).
 *
 * Colors are read via `useUnistyles()` here because React Navigation options take raw
 * color values (not Unistyles styles); the navigator re-renders on theme switch.
 */

import {Tabs} from 'expo-router'
import {Platform, StyleSheet, View} from 'react-native'
import {useUnistyles} from 'react-native-unistyles'
import {AppTopBar} from '../../src/components/AppTopBar'
import {UniIcon, type UniIconName} from '../../src/components/UniIcon'
import {NoticeDot, TAB_NOTICE_ROUTES, type TabName} from '../../src/notices'
import {useI18n} from '../../src/providers'
import {type HomeTab, recordLastHomeTab} from '../../src/services/last-home-tab'

/**
 * Remember the tab so an unlock returns the user to it. On `focus` rather than `tabPress`, so a
 * programmatic navigation counts too — what matters is where they ended up, not how.
 *
 * Menu is absent on purpose: it is a settings surface, not a home (see `last-home-tab`).
 */
const remember = (tab: HomeTab) => ({focus: () => recordLastHomeTab(tab)})

/**
 * A tab's icon, carrying the attention dot for everything reachable through that tab.
 *
 * The dot is the top of the trail: it leads to a row, which leads to the screen that wants
 * attention. Which routes belong to which tab is `TAB_NOTICE_ROUTES` — the router does not know,
 * because nav order and route order are not the same thing.
 */
function tabIcon(outline: UniIconName, filled: UniIconName, tab: TabName) {
  return ({focused, color}: {focused: boolean; color: string}) => (
    <View>
      <UniIcon name={focused ? filled : outline} color={color} width={24} height={24} />
      <NoticeDot route={TAB_NOTICE_ROUTES[tab]} size={7} style={styles.dot} testID={`tab-notice-${tab}`} />
    </View>
  )
}

const styles = StyleSheet.create({
  // Nudged off the glyph's corner so it reads as a badge on the icon rather than part of it.
  dot: {top: -2, right: -3},
})

export default function TabsLayout() {
  const {t} = useI18n()
  const {theme} = useUnistyles()

  return (
    <Tabs
      screenOptions={{
        header: () => <AppTopBar />,
        tabBarActiveTintColor: theme.colors.primaryDefault,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.backgroundNavigation,
          borderTopColor: theme.colors.borderDefaultWeak,
          // Web has no safe-area inset, so the bar hugs the viewport edge; give it
          // a floor. Native is left to React Navigation's own inset handling
          // (the OS nav buttons / home indicator) to avoid double-padding.
          ...(Platform.OS === 'web'
            ? {height: 56 + theme.spacing.spacing12, paddingBottom: theme.spacing.spacing12}
            : {}),
        },
      }}
    >
      <Tabs.Screen
        name="id"
        listeners={remember('id')}
        options={{title: t('common.nav.id'), tabBarIcon: tabIcon('account', 'accountFilled', 'id')}}
      />
      <Tabs.Screen
        name="community"
        listeners={remember('community')}
        options={{title: t('common.nav.community'), tabBarIcon: tabIcon('chat', 'chatFilled', 'community')}}
      />
      <Tabs.Screen
        name="wallets"
        listeners={remember('wallets')}
        options={{title: t('common.nav.wallets'), tabBarIcon: tabIcon('wallet', 'walletFilled', 'wallets')}}
      />
      <Tabs.Screen name="menu" options={{title: t('common.nav.menu'), tabBarIcon: tabIcon('menu', 'menu', 'menu')}} />
    </Tabs>
  )
}
