/**
 * NetworkNotice component.
 *
 * Persistent banner warning when using testnet mode.
 * Dismissible with "Don't show again" option persisted to storage.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {TouchableOpacity, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {isTestnetNetwork} from '../config/network-capabilities'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {useConfig} from '../providers/ConfigProvider'
import {useI18n} from '../providers/I18nProvider'
import {getNetworkDisplayName} from '../utils/network-utils'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

const TESTNET_NOTICE_STORAGE_KEY = '@pnyx/hide-testnet-notice'

export type NetworkNoticeProps = {
  /** Test ID */
  testID?: string
}

/**
 * NetworkNotice banner component.
 *
 * Shows prominent warning banner when using testnet mode.
 * User can dismiss permanently via storage preference.
 *
 * @example
 * ```tsx
 * <NetworkNotice />
 * ```
 */
export const NetworkNotice = ({testID = 'network-notice'}: NetworkNoticeProps) => {
  const {t} = useI18n()
  const {network} = useConfig()
  const [isVisible, setIsVisible] = useState(false)

  const isTestnet = isTestnetNetwork(network)

  // Load visibility preference
  useEffect(() => {
    const loadVisibility = async () => {
      try {
        const hidden = await storage.get(TESTNET_NOTICE_STORAGE_KEY)
        setIsVisible(isTestnet && hidden !== 'true')
      } catch (e) {
        logger.warn('Failed to load testnet notice preference', {origin: 'NetworkNotice', error: e})
        setIsVisible(isTestnet)
      }
    }
    loadVisibility()
  }, [isTestnet])

  if (!isTestnet) return null

  const handleDismiss = async () => {
    try {
      await storage.set(TESTNET_NOTICE_STORAGE_KEY, 'true')
      setIsVisible(false)
      logger.info('User dismissed testnet notice permanently', {origin: 'NetworkNotice', network})
    } catch (e) {
      logger.error('Failed to persist testnet notice dismissal', {origin: 'NetworkNotice', error: e})
      setIsVisible(false)
    }
  }

  if (!isVisible) return null

  const networkName = getNetworkDisplayName(network, false)

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <UniIcon name="info" size="sm" uniProps={(t) => ({color: t.colors.warning})} />
        </View>
        <View style={styles.textContainer}>
          <Typography variant="bodySm_medium" style={styles.title}>
            {t('settings.network.noticeTitle', {network: networkName})}
          </Typography>
          <Typography variant="bodyXs_regular" style={styles.description}>
            {t('settings.network.noticeDescription')}
          </Typography>
        </View>
        <TouchableOpacity
          onPress={handleDismiss}
          style={styles.closeButton}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
        >
          <UniIcon name="close" size="xxs" uniProps={(t) => ({color: t.colors.warning})} />
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: `${theme.colors.warning}15`,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warning,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[3],
  },
  iconContainer: {
    paddingTop: 2,
  },
  iconColor: {
    color: theme.colors.warning,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.text,
  },
  description: {
    color: theme.colors.textSecondary,
  },
  closeButton: {
    padding: theme.spacing[1],
  },
  closeIcon: {
    color: theme.colors.warning,
  },
}))
