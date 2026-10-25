/**
 * ToggleWithLabel component.
 *
 * A toggle switch with label and description text.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Toggle, type ToggleProps} from './Toggle'
import {Typography} from './Typography'

export type ToggleWithLabelProps = ToggleProps & {
  /** Label text */
  label?: string
  /** Description text */
  description?: string
  /** Whether to take full width */
  fullWidth?: boolean
}

/**
 * ToggleWithLabel component.
 *
 * A toggle switch with associated label and description text.
 *
 * @example
 * ```tsx
 * <ToggleWithLabel
 *   label="Enable notifications"
 *   description="Receive push notifications"
 *   checked={enabled}
 *   onChange={setEnabled}
 * />
 * ```
 */
export const ToggleWithLabel = ({
  checked,
  onChange,
  size = 'md',
  disabled,
  label = '',
  description = '',
  fullWidth = false,
  testID,
}: ToggleWithLabelProps) => {
  return (
    <View style={styles.container(fullWidth)}>
      <View style={styles.row}>
        <View style={styles.textColumn}>
          <Typography variant="bodyMd_medium" style={styles.title}>
            {label}
          </Typography>
          {description ? (
            <Typography variant="bodyMd_regular" style={styles.description}>
              {description}
            </Typography>
          ) : null}
        </View>
        <Toggle checked={checked} onChange={onChange} size={size} disabled={disabled ?? false} testID={testID} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: (fullWidth: boolean) => ({
    flexDirection: 'column' as const,
    gap: spacing.spacing8,
    width: fullWidth ? ('100%' as const) : 155,
  }),
  row: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.spacing12,
  },
  textColumn: {
    flex: 1,
  },
  title: {
    color: colors.textDefault,
  },
  description: {
    color: colors.textAlternative,
  },
}))
