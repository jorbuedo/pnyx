/**
 * DataRow component.
 *
 * Key-value row for displaying data pairs.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {SkeletonSquare} from '../Loaders/Skeleton'
import {Typography} from '../Typography'

export type DataRowProps = {
  /** Label/key text */
  label: string
  /** Value to display (text or custom content) */
  value?: string | ReactNode | undefined
  /** Whether value is loading */
  isLoading?: boolean | undefined
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Whether to show bottom border */
  withBorder?: boolean | undefined
  /** Value text alignment */
  valueAlign?: 'left' | 'right' | undefined
  /** Label color */
  labelColor?: string | undefined
  /** Value color */
  valueColor?: string | undefined
  /** Typography size: 'sm' (default) or 'md' for larger text */
  size?: 'sm' | 'md' | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * DataRow component.
 *
 * Displays a label-value pair, commonly used for transaction details,
 * settings, and data summaries.
 *
 * @example
 * ```tsx
 * <DataRow label="Network Fee" value="0.17 ADA" />
 * <DataRow label="Status" value={<StatusBadge status="pending" />} />
 * <DataRow label="Balance" isLoading />
 * ```
 */
export const DataRow = ({
  label,
  value,
  isLoading = false,
  onPress,
  withBorder = false,
  valueAlign = 'right',
  labelColor,
  valueColor,
  size = 'sm',
  testID,
}: DataRowProps): ReactElement => {
  const labelVariant = size === 'md' ? 'bodyMd_regular' : 'bodySm_regular'
  const valueVariant = size === 'md' ? 'bodyMd_medium' : 'bodySm_medium'

  const content = (
    <View style={styles.container(withBorder)} testID={testID}>
      <Typography variant={labelVariant} style={[styles.label, labelColor ? {color: labelColor} : null]}>
        {label}
      </Typography>
      <View style={styles.valueContainer(valueAlign)}>
        <SkeletonSquare show={isLoading} size={16} shape="square">
          {typeof value === 'string' ? (
            <Typography variant={valueVariant} style={[styles.value, valueColor ? {color: valueColor} : null]}>
              {value}
            </Typography>
          ) : (
            value
          )}
        </SkeletonSquare>
      </View>
    </View>
  )

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button">
        {content}
      </Pressable>
    )
  }

  return content
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: (withBorder: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingVertical: spacing.spacing8,
    borderBottomWidth: withBorder ? 1 : 0,
    borderBottomColor: colors.borderDefaultWeak,
    gap: spacing.spacing16,
  }),
  label: {
    color: colors.textAlternative,
  },
  value: {
    color: colors.textDefault,
  },
  valueContainer: (align: 'left' | 'right') => ({
    flex: 1,
    alignItems: align === 'right' ? ('flex-end' as const) : ('flex-start' as const),
  }),
}))
