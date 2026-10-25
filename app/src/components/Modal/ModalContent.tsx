/**
 * ModalContent component.
 *
 * Scrollable content area for Modal.
 *
 * @module
 */

import {memo, type ReactNode} from 'react'
import {ScrollView, type ScrollViewProps, type StyleProp, View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type ModalContentProps = {
  /** Content to render */
  children: ReactNode
  /** Whether content should be scrollable */
  scrollable?: boolean | undefined
  /** Maximum height for scrollable content */
  maxHeight?: number | undefined
  /** Additional ScrollView props when scrollable */
  scrollViewProps?: ScrollViewProps | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Additional style for the container */
  style?: StyleProp<ViewStyle> | undefined
}

/**
 * ModalContent component.
 *
 * Wraps modal content with optional scrolling support.
 *
 * @example
 * ```tsx
 * <ModalContent scrollable maxHeight={400}>
 *   <LongContentHere />
 * </ModalContent>
 * ```
 */
export const ModalContent = memo(
  ({children, scrollable = false, maxHeight, scrollViewProps, testID, style}: ModalContentProps) => {
    if (scrollable) {
      return (
        <ScrollView
          style={[styles.scrollContainer, maxHeight ? {maxHeight} : undefined, style]}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          testID={testID}
          {...scrollViewProps}
        >
          {children}
        </ScrollView>
      )
    }

    return (
      <View style={[styles.container, style]} testID={testID}>
        {children}
      </View>
    )
  },
)

const styles = StyleSheet.create(() => ({
  container: {
    width: '100%' as const,
  },
  scrollContainer: {
    width: '100%' as const,
    flexGrow: 0,
    // Load-bearing. The sheet's own height is clamped by `Modal`, and without a
    // shrink the ScrollView takes its *content* height, overflows that clamp and
    // clips — so long content lost its footer instead of scrolling to it. Shrinking
    // lets it fit the space the clamp leaves and scroll inside it.
    flexShrink: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
}))
