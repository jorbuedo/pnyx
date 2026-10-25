/**
 * The dot that says which option in a group is chosen.
 *
 * One implementation because a screen can hold more than one radio group, and two of them drawn
 * differently read as two different kinds of control: the community composer had a picker whose
 * selection was a border colour sitting directly above one that drew this, and the border-only half
 * did not read as selectable at all.
 *
 * Mark only — the `Pressable`, the `accessibilityRole="radio"` and the `accessibilityState` belong
 * to the row that owns the press target, and duplicating them here would nest two of each.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type RadioMarkProps = {
  readonly selected: boolean
}

export const RadioMark = ({selected}: RadioMarkProps) => {
  styles.useVariants({selected})
  return <View style={styles.outer}>{selected && <View style={styles.inner} />}</View>
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.roundedCircle,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    variants: {
      selected: {
        true: {borderColor: theme.colors.primaryDefault},
        false: {borderColor: theme.colors.borderDefaultStrong},
      },
    },
  },
  inner: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.roundedCircle,
    backgroundColor: theme.colors.primaryDefault,
  },
}))
