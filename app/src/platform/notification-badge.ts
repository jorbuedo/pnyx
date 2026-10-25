import notifee from '@notifee/react-native'
import {logger} from '../logger'

export async function setAppBadgeCount(count: number): Promise<void> {
  try {
    await notifee.setBadgeCount(Math.max(0, Math.floor(count)))
  } catch (e) {
    logger.warn('Failed to set app badge count', {origin: 'push-notifications/badge', cause: e, count})
  }
}
