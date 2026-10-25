import type {ReactElement} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'

export type SegmentedControlOption<T extends string = string> = {
  /** Display label */
  readonly label: string
  /** Value emitted on selection */
  readonly value: T
  /** Optional test ID suffix — resolves to `${testID}-${value}` */
  readonly testID?: string | undefined
}

export type SegmentedControlProps<T extends string = string> = {
  /** List of options to render */
  readonly options: readonly SegmentedControlOption<T>[]
  /** Currently selected value */
  readonly value: T
  /** Called when the user taps a different option */
  readonly onChange: (value: T) => void
  /** Base test ID applied to the container; each item appends `-${option.value}` */
  readonly testID?: string | undefined
}

/**
 * @example
 * ```tsx
 * <SegmentedControl
 *   options={[
 *     {label: 'Buy', value: 'buy'},
 *     {label: 'Sell', value: 'sell'},
 *   ]}
 *   value={orderType}
 *   onChange={setOrderType}
 * />
 * ```
 */
function SegmentedControlInner<T extends string>({options, value, onChange, testID}: SegmentedControlProps<T>) {
  return (
    <View style={styles.containerTrack} testID={testID}>
      <ChamferBackground size="auto" fillToken="backgroundLayer1" borderToken="borderDefaultStrong" borderWidth={1} />
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <Pressable
            key={option.value}
            style={styles.optionTrack}
            onPress={() => onChange(option.value)}
            testID={option.testID ?? (testID ? `${testID}-${option.value}` : undefined)}
          >
            {isActive && <ChamferBackground size="auto" fillToken="primaryDefault" />}
            <Typography
              variant="bodyMd_medium"
              numberOfLines={1}
              style={isActive ? styles.labelActiveTrack : styles.labelTrack}
            >
              {option.label}
            </Typography>
          </Pressable>
        )
      })}
    </View>
  )
}

export const SegmentedControl = SegmentedControlInner as <T extends string>(
  props: SegmentedControlProps<T>,
) => ReactElement

const styles = StyleSheet.create((theme) => ({
  containerTrack: {
    flexDirection: 'row',
    padding: theme.spacing.spacing2,
  },
  optionTrack: {
    flex: 1,
    minHeight: 30,
    paddingHorizontal: theme.spacing.spacing6,
    paddingVertical: theme.spacing.spacing4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelTrack: {
    color: theme.colors.textDefault,
  },
  labelActiveTrack: {
    color: theme.colors.primaryInverse,
  },
}))
