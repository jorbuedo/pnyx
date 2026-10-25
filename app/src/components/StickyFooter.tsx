/**
 * StickyFooter component.
 *
 * A reusable footer bar anchored at the bottom of a screen.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type StickyFooterProps = {
  children: ReactNode
  /** Test ID for e2e testing */
  testID?: string
  /** Extra bottom inset to keep the footer above persistent navigation UI */
  bottomInset?: number
}

/**
 * Footer bar for action buttons.
 *
 * Extends through the bottom safe area via its own bottom padding. The
 * parent screen should exclude the `bottom` edge from its SafeAreaView
 * to avoid double-padding.
 *
 * @example
 * ```tsx
 * <SafeAreaViewWrapper edges={['top']}>
 *   <ScrollView>...</ScrollView>
 *   <StickyFooter>
 *     <Button label="Continue" onPress={handleContinue} fullWidth />
 *   </StickyFooter>
 * </SafeAreaViewWrapper>
 * ```
 */
export const StickyFooter = ({children, testID, bottomInset = 0}: StickyFooterProps) => {
  return (
    <View style={styles.content(bottomInset)} testID={testID}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  content: (bottomInset: number) => ({
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing12,
    paddingBottom: theme.spacing.spacing16 + bottomInset + rt.insets.bottom,
    // Stacked actions were flush against each other in every footer that has
    // more than one (primary + Cancel reads as one control without this).
    gap: theme.spacing.spacing8,
  }),
}))
