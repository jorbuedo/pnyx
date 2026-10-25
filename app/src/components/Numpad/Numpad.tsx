/**
 * Numpad component.
 *
 * Complete numpad with value management.
 *
 * @module
 */

import {type ReactElement, useCallback} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from '../Typography'
import {NumpadBase, type NumpadBaseProps} from './NumpadBase'

export type NumpadProps = Omit<NumpadBaseProps, 'onKeyPress' | 'onBackspace' | 'onBackspaceLongPress'> & {
  /** Current value */
  value: string
  /** Value change handler */
  onChange: (value: string) => void
  /** Maximum decimal places */
  maxDecimals?: number | undefined
  /** Maximum value length */
  maxLength?: number | undefined
  /** Whether to show the value display */
  showDisplay?: boolean | undefined
  /** Value prefix (e.g., currency symbol) */
  prefix?: string | undefined
  /** Value suffix (e.g., token symbol) */
  suffix?: string | undefined
}

/**
 * Numpad component.
 *
 * A numeric input pad with built-in value management.
 *
 * @example
 * ```tsx
 * <Numpad
 *   value={amount}
 *   onChange={setAmount}
 *   maxDecimals={6}
 *   showDisplay
 *   suffix="ADA"
 * />
 * ```
 */
export const Numpad = ({
  value,
  onChange,
  maxDecimals = 6,
  maxLength = 12,
  showDisplay = false,
  prefix,
  suffix,
  showDecimal = true,
  decimalSeparator = '.',
  isDisabled = false,
  testID,
}: NumpadProps): ReactElement => {
  const handleKeyPress = useCallback(
    (key: string) => {
      if (key === decimalSeparator) {
        // Don't allow multiple decimal separators
        if (value.includes(decimalSeparator)) return
        // Don't start with decimal
        if (value === '' || value === '0') {
          onChange(`0${decimalSeparator}`)
          return
        }
        onChange(value + decimalSeparator)
        return
      }

      // Handle numeric input
      const newValue = value === '0' ? key : value + key

      // Check max length
      if (newValue.replace(decimalSeparator, '').length > maxLength) return

      // Check decimal places
      if (newValue.includes(decimalSeparator)) {
        const decimalPart = newValue.split(decimalSeparator)[1]
        if (decimalPart && decimalPart.length > maxDecimals) return
      }

      onChange(newValue)
    },
    [value, onChange, maxDecimals, maxLength, decimalSeparator],
  )

  const handleBackspace = useCallback(() => {
    if (value.length <= 1) {
      onChange('0')
      return
    }
    onChange(value.slice(0, -1))
  }, [value, onChange])

  const handleBackspaceLongPress = useCallback(() => {
    onChange('0')
  }, [onChange])

  return (
    <View style={styles.container} testID={testID}>
      {showDisplay ? (
        <View style={styles.displayContainer}>
          <Typography variant="headingXl" style={styles.displayText}>
            {prefix}
            {value || '0'}
            {suffix ? ` ${suffix}` : ''}
          </Typography>
        </View>
      ) : null}
      <NumpadBase
        onKeyPress={handleKeyPress}
        onBackspace={handleBackspace}
        onBackspaceLongPress={handleBackspaceLongPress}
        showDecimal={showDecimal}
        decimalSeparator={decimalSeparator}
        isDisabled={isDisabled}
      />
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: {
    alignItems: 'center' as const,
  },
  displayContainer: {
    paddingVertical: spacing.spacing24,
    paddingHorizontal: spacing.spacing16,
    alignItems: 'center' as const,
  },
  displayText: {
    color: colors.textDefault,
  },
}))
