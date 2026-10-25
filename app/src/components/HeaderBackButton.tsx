/**
 * Shared back button component for stack navigator headers.
 *
 * Used in nested stack layouts to provide a consistent back button
 * on iOS where the default back button doesn't appear for the first
 * screen in a nested stack.
 *
 * Uses react-native-gesture-handler's Pressable to fix Android touch
 * issues with headerTransparent: true (see react-navigation#12667).
 *
 * @module
 */

import {router, usePathname} from 'expo-router'
import {Pressable} from 'react-native-gesture-handler'

import {UniIcon} from './UniIcon'

/**
 * When there's no in-app history to pop (deep link, notification tap, a
 * `replace` that reset the stack), fall back to the TAB the current screen
 * belongs to — not a blanket `/community`, which strands a user who opened a
 * wallet screen directly. Keyed off the route prefix.
 */
const fallbackFor = (pathname: string): string => {
  if (pathname.startsWith('/wallet')) return '/wallets'
  if (pathname.startsWith('/settings')) return '/menu'
  return '/community'
}

/**
 * Back button for stack navigator headers.
 *
 * @param color - Optional override for chevron color. Defaults to theme.colors.textDefault.
 * @param onBack - Optional override for the back action. Defaults to router.back() or replace to /home.
 */
export const HeaderBackButton = ({color, onBack}: {color?: string; onBack?: () => void}) => {
  const pathname = usePathname()
  const handlePress = () => {
    if (onBack) {
      onBack()
    } else if (router.canGoBack()) {
      router.back()
    } else {
      router.replace(fallbackFor(pathname) as Parameters<typeof router.replace>[0])
    }
  }

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
      style={({pressed}) => ({
        padding: 5,
        opacity: pressed ? 0.6 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      })}
      testID="back-button"
    >
      <UniIcon
        name="chevronLeft"
        size="md"
        {...(color != null ? {color} : {uniProps: (t) => ({color: t.colors.textDefault})})}
      />
    </Pressable>
  )
}
