/**
 * NumpadBase component.
 *
 * Base numpad grid without input handling.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {NumpadButton} from './NumpadButton'

export type NumpadBaseProps = {
  /** Key press handler */
  onKeyPress: (key: string) => void
  /** Backspace handler */
  onBackspace?: (() => void) | undefined
  /** Backspace long press handler */
  onBackspaceLongPress?: (() => void) | undefined
  /** Whether to show decimal point */
  showDecimal?: boolean | undefined
  /** Custom decimal separator */
  decimalSeparator?: string | undefined
  /** Whether numpad is disabled */
  isDisabled?: boolean | undefined
  /** Custom element for the bottom-left slot (replaces decimal/placeholder) */
  leftButton?: ReactElement | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
]

/**
 * NumpadBase component.
 *
 * A basic numeric keypad layout.
 *
 * @example
 * ```tsx
 * <NumpadBase
 *   onKeyPress={handleKey}
 *   onBackspace={handleBackspace}
 *   showDecimal
 * />
 * ```
 */
export const NumpadBase = ({
  onKeyPress,
  onBackspace,
  onBackspaceLongPress,
  showDecimal = true,
  decimalSeparator = '.',
  isDisabled = false,
  leftButton,
  testID,
}: NumpadBaseProps): ReactElement => {
  const renderBottomLeft = () => {
    if (leftButton) return leftButton
    if (showDecimal) {
      return (
        <NumpadButton value={decimalSeparator} onPress={() => onKeyPress(decimalSeparator)} isDisabled={isDisabled} />
      )
    }
    return <View style={styles.placeholder} />
  }

  return (
    <View style={styles.container} testID={testID}>
      {KEYS.map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static grid layout
        <View key={rowIndex} style={styles.row}>
          {row.map((key) => (
            <NumpadButton
              key={key}
              value={key}
              onPress={() => onKeyPress(key)}
              isDisabled={isDisabled}
              testID={`numpad-key-${key}`}
            />
          ))}
        </View>
      ))}
      <View style={styles.row}>
        {renderBottomLeft()}
        <NumpadButton value="0" onPress={() => onKeyPress('0')} isDisabled={isDisabled} testID="numpad-key-0" />
        <NumpadButton
          icon="backspace"
          onPress={onBackspace}
          onLongPress={onBackspaceLongPress}
          isDisabled={isDisabled}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing8,
    paddingHorizontal: spacing.spacing8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.spacing16,
  },
  placeholder: {
    flex: 1,
    minWidth: 72,
  },
}))
