/**
 * EmptyState component.
 *
 * Displays a centered placeholder for empty lists or states with optional icon,
 * title, description, and action button.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from './Buttons'
import {ChamferSurface} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

/** Empty state action button configuration */
export type EmptyStateAction = {
  /** Button label */
  label: string
  /** Press handler */
  onPress: () => void
}

/** Empty state visual variant */
export type EmptyStateVariant = 'default' | 'minimal'

export type EmptyStateProps = {
  /** Title text */
  title: string
  /** Optional description text */
  description?: string | undefined
  /** Optional icon name or React element */
  icon?: UniIconName | ReactElement | undefined
  /** Optional action button */
  action?: EmptyStateAction | undefined
  /** Visual variant */
  variant?: EmptyStateVariant | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * EmptyState component.
 *
 * Displays a placeholder for empty content states like empty lists,
 * no search results, or waiting states.
 *
 * @example
 * ```tsx
 * // Basic empty state
 * <EmptyState
 *   title="No transactions"
 *   description="Your transaction history will appear here"
 * />
 *
 * // With icon and action
 * <EmptyState
 *   icon="wallet"
 *   title="No wallets found"
 *   description="Create a wallet to get started"
 *   action={{ label: "Create Wallet", onPress: handleCreate }}
 * />
 *
 * // Minimal variant
 * <EmptyState
 *   variant="minimal"
 *   title="No results"
 * />
 * ```
 */
export const EmptyState = ({
  title,
  description,
  icon,
  action,
  variant = 'default',
  testID,
}: EmptyStateProps): ReactElement => {
  const renderIcon = () => {
    if (!icon) return null

    // React element
    if (typeof icon === 'object') {
      return <View style={styles.iconContainer}>{icon}</View>
    }

    // UniIcon name
    return (
      <View style={styles.iconContainer}>
        <ChamferSurface size="auto" fillToken="backgroundAlternative" style={styles.iconBackground}>
          <UniIcon
            name={icon}
            size={variant === 'minimal' ? 'lg' : 'xxl'}
            uniProps={(theme) => ({color: theme.colors.iconMuted})}
          />
        </ChamferSurface>
      </View>
    )
  }

  return (
    <View style={styles.container} testID={testID}>
      {renderIcon()}
      <Typography variant={variant === 'minimal' ? 'bodyMd_medium' : 'headingMd'} style={styles.title}>
        {title}
      </Typography>
      {description ? (
        <Typography variant="bodySm_regular" style={styles.description}>
          {description}
        </Typography>
      ) : null}
      {action ? (
        <View style={styles.actionContainer}>
          <Button
            label={action.label}
            onPress={action.onPress}
            variant={variant === 'minimal' ? 'nakedDefault' : 'primary'}
            size="md"
            testID={testID ? `${testID}-action` : undefined}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.spacing24,
    gap: spacing.spacing12,
  },
  iconContainer: {
    paddingBottom: spacing.spacing8,
  },
  iconBackground: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: colors.textDefault,
    textAlign: 'center',
  },
  description: {
    color: colors.textAlternative,
    textAlign: 'center',
    maxWidth: 280,
  },
  actionContainer: {
    paddingTop: spacing.spacing8,
  },
}))
