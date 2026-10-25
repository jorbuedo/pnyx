/**
 * UI Playground layout.
 *
 * Stack layout with themed header for the UI Playground screens.
 * Includes theme toggle in header for testing components in light/dark modes.
 *
 * @module
 */

import {Stack} from 'expo-router'
import {Pressable} from 'react-native'
import {useUnistyles} from 'react-native-unistyles'
import {ThemedStack} from '../../src/components/ThemedStack'
import {UniIcon} from '../../src/components/UniIcon'
import {useTheme} from '../../src/providers'
import {useIsDark} from '../../src/theme'

function ThemeToggle() {
  const {theme} = useUnistyles()
  const {toggleTheme} = useTheme()
  const isDark = useIsDark()

  return (
    <Pressable onPress={toggleTheme} hitSlop={8}>
      <UniIcon name={isDark ? 'lightMode' : 'nightMode'} size="md" color={theme.colors.textDefault} />
    </Pressable>
  )
}

export default function UIPlaygroundLayout() {
  return (
    <ThemedStack>
      <Stack.Screen
        name="index"
        options={{headerLeft: () => null, title: 'UI Playground', headerRight: () => <ThemeToggle />}}
      />
    </ThemedStack>
  )
}
