/**
 * ModalActions component.
 *
 * Footer section for Modal with action buttons.
 *
 * @module
 */

import {memo} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button, type ButtonBaseVariant, type ButtonSize} from '../Buttons'

/** Action button configuration */
export type ModalAction = {
  /** Button size */
  size?: ButtonSize | undefined
  /** Button label */
  label: string
  /** Press handler */
  onPress: () => void
  /** Button variant */
  variant?: ButtonBaseVariant | undefined
  /** Whether this is an error/destructive action (renders error color scheme) */
  isError?: boolean | undefined
  /** Whether button is disabled */
  disabled?: boolean | undefined
  /** Whether button is in loading state */
  loading?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

export type ModalActionsProps = {
  /** Array of action buttons */
  actions: ModalAction[]
  /** Layout direction */
  layout?: 'horizontal' | 'vertical' | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * ModalActions component.
 *
 * Renders action buttons in the modal footer.
 *
 * @example
 * ```tsx
 * <ModalActions
 *   actions={[
 *     { label: 'Cancel', onPress: handleCancel, variant: 'secondary' },
 *     { label: 'Confirm', onPress: handleConfirm, variant: 'primary' },
 *   ]}
 *   layout="horizontal"
 * />
 * ```
 */
export const ModalActions = memo(({actions, layout = 'horizontal', testID}: ModalActionsProps) => {
  if (actions.length === 0) {
    return null
  }

  const isHorizontal = layout === 'horizontal'

  return (
    <View style={[styles.container, isHorizontal ? styles.horizontal : styles.vertical]} testID={testID}>
      {actions.map((action, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: Actions are static
          key={index}
          style={isHorizontal ? styles.horizontalButton : styles.verticalButton}
        >
          <Button
            label={action.label}
            onPress={action.onPress}
            variant={action.variant ?? 'primary'}
            isError={action.isError}
            isDisabled={action.disabled}
            isLoading={action.loading}
            size={action.size ?? 'md'}
            fullWidth
            testID={action.testID}
          />
        </View>
      ))}
    </View>
  )
})

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    width: '100%' as const,
    paddingTop: spacing.spacing16,
  },
  horizontal: {
    flexDirection: 'row' as const,
    gap: spacing.spacing12,
  },
  vertical: {
    flexDirection: 'column' as const,
    gap: spacing.spacing12,
  },
  horizontalButton: {
    flex: 1,
  },
  verticalButton: {
    width: '100%' as const,
  },
}))
