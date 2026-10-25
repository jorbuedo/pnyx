/**
 * AppShell component for responsive layouts.
 *
 * Provides a responsive layout that adapts between narrow (phone/popup)
 * and wide (tablet/fullscreen) modes based on Unistyles breakpoints.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type AppShellProps = {
  /** Sidebar content (hidden on narrow, visible on wide) */
  sidebar?: ReactNode
  /** Main content area */
  children: ReactNode
}

/**
 * Responsive app shell with optional sidebar.
 *
 * On narrow screens (< 768px): Sidebar hidden, content fills screen
 * On wide screens (>= 768px): Sidebar visible on left, content on right
 *
 * @example
 * ```tsx
 * <AppShell sidebar={<NavigationMenu />}>
 *   <HomeScreen />
 * </AppShell>
 * ```
 */
export const AppShell = ({sidebar, children}: AppShellProps) => {
  return (
    <View style={styles.container}>
      {sidebar && <View style={styles.sidebar}>{sidebar}</View>}
      <View style={styles.content}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    flexDirection: {
      xs: 'column',
      md: 'row',
    },
    backgroundColor: theme.colors.backgroundDefault,
  },
  sidebar: {
    display: {
      xs: 'none',
      md: 'flex',
    },
    width: {
      md: 280,
    },
    backgroundColor: theme.colors.backgroundAlternative,
    borderRightWidth: 1,
    borderRightColor: theme.colors.borderDefaultWeak,
  },
  content: {
    flex: 1,
  },
}))
