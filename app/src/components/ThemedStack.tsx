/**
 * The app's Stack navigator, themed and with the standard back affordance.
 *
 * Every stack layout previously declared its own
 * `withUnistyles(Stack, (theme) => ({screenOptions: getSharedStackScreenOptions(theme)}))`
 * — five near-identical copies — and then repeated
 * `headerLeft: () => <HeaderBackButton />` on each individual screen, 45 times.
 * Both live here now: the back button is part of the default screen options, so
 * a pushed screen gets it without asking.
 *
 * A screen that should *not* offer back (a stack root, a terminal step) opts out
 * with `headerLeft: () => null`, which is the shape `app/onboarding` already
 * used before this was shared.
 *
 * @module
 */

import {Stack} from 'expo-router'
import {withUnistyles} from 'react-native-unistyles'

import {getSharedStackScreenOptions} from '../theme'
import {HeaderBackButton} from './HeaderBackButton'

export const ThemedStack = withUnistyles(Stack, (theme) => ({
  screenOptions: {
    ...getSharedStackScreenOptions(theme),
    headerLeft: () => <HeaderBackButton />,
  } as const,
}))

/**
 * Onboarding additionally suppresses the platform back chevron, because its
 * flow controls navigation itself and a native back would skip steps.
 */
export const ThemedOnboardingStack = withUnistyles(Stack, (theme) => ({
  screenOptions: {
    ...getSharedStackScreenOptions(theme),
    headerBackVisible: false,
    headerLeft: () => <HeaderBackButton />,
  } as const,
}))
