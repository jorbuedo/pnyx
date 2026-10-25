/**
 * Web stub for push notification utilities.
 * Firebase and Notifee are not supported on web.
 * handlePushNavigation is kept functional since expo-router and Linking work on web.
 */

import {Linking} from 'react-native'

import {logger} from '../logger'
import type {PushNavigationTarget} from '../services/notification-types'

export async function triggerNotificationsPermissionModal(): Promise<void> {}

export async function hasNotificationsPermission(): Promise<boolean> {
  return false
}

export async function requestNotificationsPermission(): Promise<boolean> {
  return false
}

export async function getNotificationsAuthorizationStatus(): Promise<'authorized' | 'denied' | 'not_determined'> {
  return 'not_determined'
}

export function handlePushNavigation(data: Record<string, unknown>, _screen?: PushNavigationTarget): void {
  if (typeof data.open_url === 'string') {
    Linking.openURL(data.open_url).catch((e) => {
      logger.error('Failed to open notification URL', {origin: 'push-notifications/tools', cause: e})
    })
  }
}

export async function registerDeviceToken(): Promise<void> {}

export async function subscribeToUserTopic(_userId: string): Promise<void> {}

export async function unsubscribeFromUserTopic(): Promise<void> {}

export async function unsubscribeUserTopicForGroup(_groupId: string): Promise<void> {}

export async function subscribeToCampaignsTopic(): Promise<void> {}

export async function unsubscribeFromCampaignsTopic(): Promise<void> {}

export function useRequestSystemNotifications(_opts: {enabled: boolean}): void {}
