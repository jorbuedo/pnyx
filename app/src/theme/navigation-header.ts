/**
 * Canonical Stack screen options for every navigator in the wallet app.
 *
 * Every page header (Settings, Notifications, community screens, …) shares
 * the same shape: centered title, semi-bold weight, default React Navigation
 * header font size. This helper is
 * the single source of truth — Stack layouts pass it through
 * `withUnistyles(Stack, (theme) => ({screenOptions: getSharedStackScreenOptions(theme)}))`
 * and override only what truly differs per stack.
 *
 * @module
 */

import {Platform} from 'react-native'
import {isDarkThemeName} from './theme-names'

import type {Theme} from './tokens'

export const getSharedStackScreenOptions = (theme: Theme) =>
  ({
    headerShown: true,
    headerTitleAlign: 'center',
    headerStyle: {
      backgroundColor: theme.colors.backgroundDefault,
    },
    headerTintColor: theme.colors.textDefault,
    headerTitleStyle: {
      fontWeight: theme.fontWeights.semiBold,
      color: theme.colors.textDefault,
    },
    headerShadowVisible: false,
    headerBackTitle: '',
    // Android-only: iOS react-native-screens RCTLogErrors on a per-screen statusBarStyle
    // unless UIViewControllerBasedStatusBarAppearance is YES; iOS uses the root expo-status-bar setter.
    statusBarStyle: Platform.OS === 'android' ? (isDarkThemeName(theme.name) ? 'light' : 'dark') : undefined,
    contentStyle: {
      backgroundColor: 'transparent',
    },
  }) as const
