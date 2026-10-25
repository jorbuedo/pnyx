/**
 * NetworkBadge — the header's "you are not on mainnet" pill.
 *
 * Renders nothing on mainnet: the badge exists to make a test network
 * impossible to miss, and a permanent "MAINNET" chip would just be furniture.
 * Tapping it opens the network picker.
 *
 * @module
 */

import {router} from 'expo-router'
import {Pressable} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {isTestnetNetwork} from '../config/network-capabilities'
import {NETWORK_COLORS} from '../config/networks'
import {logger} from '../logger'
import {useConfig} from '../providers/ConfigProvider'
import {useI18n} from '../providers/I18nProvider'
import {getNetworkDisplayName} from '../utils/network-utils'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'

export type NetworkBadgeProps = {
  /** Uppercase short form (the header pill); false renders the full name. */
  compact?: boolean
  /** Render as a plain indicator, without opening the picker on tap. */
  disabled?: boolean
  testID?: string
}

export const NetworkBadge = ({compact = true, disabled = false, testID = 'network-badge'}: NetworkBadgeProps) => {
  const {network} = useConfig()
  const {t} = useI18n()

  if (!isTestnetNetwork(network)) return null

  const displayName = getNetworkDisplayName(network, compact)

  return (
    <Pressable
      onPress={() => {
        logger.info('User tapped network badge', {origin: 'NetworkBadge', network})
        router.push('/settings/network')
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('settings.network.badgeAccessibilityLabel', {network: displayName})}
      style={({pressed}) => [styles.badge, pressed && styles.badgePressed]}
      testID={testID}
    >
      <ChamferBackground size="auto" fill={NETWORK_COLORS[network]} />
      <Typography variant="bodyXs_medium" style={styles.text}>
        {displayName}
      </Typography>
    </Pressable>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  badge: {
    flexShrink: 0,
    paddingHorizontal: spacing.spacing8,
    paddingVertical: spacing.spacing2,
  },
  badgePressed: {
    opacity: 0.7,
  },
  text: {
    color: colors.primaryInverse,
    letterSpacing: 0.5,
  },
}))
