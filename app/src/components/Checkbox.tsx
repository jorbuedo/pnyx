/**
 * Checkbox component.
 *
 * A standalone checkbox with check or minus icon variants.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from './Chamfer'
import {SkeletonSquare} from './Loaders/Skeleton'
import {UniIcon} from './UniIcon'

/** Icon variant for the checkbox */
export type CheckboxIconVariant = 'check' | 'minus'

export type CheckboxProps = {
  /** Icon variant when checked */
  iconVariant?: CheckboxIconVariant | undefined
  /** Whether the checkbox is checked */
  checked?: boolean | undefined
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Whether the checkbox is disabled */
  isDisabled?: boolean | undefined
  /** Whether to show loading skeleton */
  isLoading?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

const CHECKBOX_SIZE = 20

/**
 * Checkbox component.
 *
 * @example
 * ```tsx
 * <Checkbox checked={isChecked} onPress={() => setIsChecked(!isChecked)} />
 * <Checkbox checked={isPartial} iconVariant="minus" />
 * <Checkbox isDisabled />
 * ```
 */
export const Checkbox = ({
  checked = false,
  onPress,
  iconVariant = 'check',
  isDisabled = false,
  isLoading = false,
  testID,
}: CheckboxProps) => {
  const handlePress = () => {
    if (!isDisabled) {
      onPress?.()
    }
  }

  const iconName = iconVariant === 'check' ? 'check' : 'minus'

  return (
    <SkeletonSquare size={CHECKBOX_SIZE} show={isLoading} shape="square">
      <Pressable
        onPress={handlePress}
        disabled={isDisabled}
        testID={testID}
        accessibilityRole="checkbox"
        accessibilityState={{checked, disabled: isDisabled}}
        style={{opacity: isDisabled ? 0.3 : 1}}
      >
        <View style={styles.checkboxContent}>
          <ChamferBackground
            size="auto"
            fillToken={checked ? 'primaryDefault' : 'backgroundAlternative'}
            {...(checked ? {} : {borderToken: 'iconDefault' as const, borderWidth: 1})}
          />
          {checked && (
            <UniIcon name={iconName} size="xs" uniProps={(theme) => ({color: theme.colors.primaryInverse})} />
          )}
        </View>
      </Pressable>
    </SkeletonSquare>
  )
}

const styles = StyleSheet.create(() => ({
  checkboxContent: {
    justifyContent: 'center',
    alignItems: 'center',
    height: CHECKBOX_SIZE,
    width: CHECKBOX_SIZE,
  },
}))
