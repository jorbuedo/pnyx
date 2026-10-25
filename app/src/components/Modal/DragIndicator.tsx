/**
 * The bottom-sheet grab handle.
 *
 * One definition because there are two render sites — `Modal` draws it directly
 * when a sheet has no header, `ModalHeader` draws it above the title when it
 * does — and a third copy elsewhere had already drifted to a different token.
 *
 * @module
 */

import type {ReactElement} from 'react'
import type {GestureResponderHandlers} from 'react-native'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type DragIndicatorProps = {
  /** Tap handler; omit to leave the handle inert. */
  onPress?: (() => void) | undefined
  /** Pan handlers to spread onto the pressable, when the host drives a drag. */
  panHandlers?: GestureResponderHandlers | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

export const DragIndicator = ({onPress, panHandlers, testID}: DragIndicatorProps): ReactElement => (
  <Pressable {...panHandlers} style={styles.container} onPress={onPress} testID={testID}>
    <View style={styles.pill} />
  </Pressable>
)

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    alignItems: 'center' as const,
    paddingVertical: spacing.spacing8,
  },
  pill: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderDefaultWeak,
  },
}))
