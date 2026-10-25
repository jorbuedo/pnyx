/**
 * Tab component.
 *
 * Individual tab button in a tab bar.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {Pressable} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Badge} from '../Badge'
import {Typography} from '../Typography'

export type TabProps = {
  /** Tab label text */
  label: string
  /** Whether this tab is currently active */
  isActive?: boolean | undefined
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Badge count to display */
  badge?: number | undefined
  /** Whether tab is disabled */
  isDisabled?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Tab component.
 *
 * Individual tab button with optional badge indicator.
 *
 * @example
 * ```tsx
 * <Tab
 *   label="Overview"
 *   isActive={activeTab === 'overview'}
 *   onPress={() => setActiveTab('overview')}
 *   badge={3}
 * />
 * ```
 */
export const Tab = ({label, isActive = false, onPress, badge, isDisabled = false, testID}: TabProps): ReactElement => {
  styles.useVariants({active: isActive})

  return (
    <Pressable
      style={styles.container(isDisabled)}
      onPress={isDisabled ? undefined : onPress}
      testID={testID}
      accessibilityRole="tab"
      accessibilityState={{selected: isActive, disabled: isDisabled}}
    >
      <Typography variant={isActive ? 'bodySm_medium' : 'bodySm_regular'} style={styles.label}>
        {label}
      </Typography>
      {badge !== undefined && badge > 0 ? <Badge networkCount={badge} size="md" /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: (isDisabled: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing4,
    paddingVertical: spacing.spacing8,
    paddingHorizontal: spacing.spacing16,
    opacity: isDisabled ? 0.4 : 1,
  }),
  label: {
    variants: {
      active: {
        true: {color: colors.textDefault},
        false: {color: colors.textAlternative},
      },
    },
  },
}))
