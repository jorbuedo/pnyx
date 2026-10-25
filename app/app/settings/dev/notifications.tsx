/**
 * Dev notifications test screen.
 *
 * Trigger local notifications via Notifee to test the push notification
 * system without needing real FCM messages. Also exposes permission
 * management and event history inspection.
 *
 * Only accessible from Developer Tools (devTools feature flag required).
 */

import notifee, {AndroidImportance, TriggerType} from '@notifee/react-native'
import {useCallback, useState} from 'react'
import {Alert} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {SettingsRow} from '../../../src/components/SettingsRow'
import {SettingsSection} from '../../../src/components/SettingsSection'
import {useToast} from '../../../src/hooks/useToast'
import {rotateFcmToken} from '../../../src/platform/fcm-token'
import {NOTIFEE_CHANNEL_ID} from '../../../src/platform/notifee-setup'
import {NOTIFICATION_SMALL_ICON} from '../../../src/platform/notification-channel'
import {
  getNotificationsAuthorizationStatus,
  triggerNotificationsPermissionModal,
} from '../../../src/platform/notification-tools'
import {useI18n, usePnyxSession} from '../../../src/providers'
import {registerDeviceWithService} from '../../../src/services/device-registration'
import {pushNotificationManager} from '../../../src/services/notification-manager'
import {notificationPrefs} from '../../../src/services/notification-storage'
import {Trigger} from '../../../src/services/notification-types'

async function triggerLocalNotification(
  title: string,
  body: string,
  data: Record<string, string>,
  trigger: Trigger = Trigger.Push,
): Promise<void> {
  const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)

  await pushNotificationManager.events.push({
    id,
    date: new Date().toISOString(),
    isRead: false,
    title,
    body,
    data,
    trigger,
  })

  await notifee.displayNotification({
    title,
    body,
    android: {
      channelId: NOTIFEE_CHANNEL_ID,
      smallIcon: NOTIFICATION_SMALL_ICON,
      importance: AndroidImportance.HIGH,
      pressAction: {id: 'default'},
    },
    ios: {
      foregroundPresentationOptions: {
        banner: true,
        sound: true,
        badge: true,
      },
    },
    data: {...data, id: String(id)},
  })
}

async function triggerDelayedNotification(
  title: string,
  body: string,
  data: Record<string, string>,
  delayMs: number = 5000,
): Promise<void> {
  const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)

  await pushNotificationManager.events.push({
    id,
    date: new Date().toISOString(),
    isRead: false,
    title,
    body,
    data,
    trigger: Trigger.Push,
  })

  await notifee.createTriggerNotification(
    {
      title,
      body,
      android: {
        channelId: NOTIFEE_CHANNEL_ID,
        smallIcon: NOTIFICATION_SMALL_ICON,
        importance: AndroidImportance.HIGH,
        pressAction: {id: 'default'},
      },
      ios: {
        foregroundPresentationOptions: {
          banner: true,
          sound: true,
          badge: true,
        },
      },
      data: {...data, id: String(id)},
    },
    {
      type: TriggerType.TIMESTAMP,
      timestamp: Date.now() + delayMs,
    },
  )
}

export default function DevNotificationsScreen() {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {showToast} = useToast()
  const [rotating, setRotating] = useState(false)

  /**
   * Mint a new FCM token and re-bind it to this identity.
   *
   * Here because the only other way to rotate a token is uninstalling the app, which costs the
   * device its identity — see {@link rotateFcmToken} for why `getToken()` cannot do it alone.
   */
  const rotate = useCallback(async () => {
    setRotating(true)
    try {
      const fresh = await rotateFcmToken()
      if (fresh === null) {
        showToast({message: t('settings.developer.fcmRotateFailed'), variant: 'error'})
        return
      }
      await notificationPrefs.fcmToken.set(fresh)
      if (session === undefined) {
        // The token is stored either way; without a session there is nobody to bind it to yet.
        showToast({message: t('settings.developer.fcmRotatedNoSession'), variant: 'warning'})
        return
      }
      const registered = await registerDeviceWithService(session, fresh)
      showToast({
        message: registered ? t('settings.developer.fcmRotated') : t('settings.developer.fcmRotateFailed'),
        variant: registered ? 'success' : 'error',
      })
    } finally {
      setRotating(false)
    }
  }, [session, showToast, t])

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <SettingsSection title={t('settings.developer.fcmTokenSection')}>
        <SettingsRow
          label={t('settings.developer.fcmRotate')}
          description={t('settings.developer.fcmRotateDescription')}
        >
          <Button
            label={t('settings.developer.fcmRotateAction')}
            variant="secondary"
            size="sm"
            isLoading={rotating}
            onPress={() => void rotate()}
            testID="notif-rotate-token"
          />
        </SettingsRow>
      </SettingsSection>

      {/* Local Notifications */}
      <SettingsSection title={t('settings.developer.localNotificationsSection')}>
        <SettingsRow
          label={t('settings.developer.simpleNotification')}
          description={t('settings.developer.simpleNotificationDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerLocalNotification(
                t('settings.developer.testNotificationTitle'),
                t('settings.developer.testNotificationBody'),
                {},
              )
            }
            testID="notif-simple"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.walletActivity')}
          description={t('settings.developer.walletActivityDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerLocalNotification(
                t('settings.developer.walletActivityNotificationTitle'),
                t('settings.developer.walletActivityNotificationBody'),
                {screen: 'home'},
              )
            }
            testID="notif-wallet"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.stakingReward')}
          description={t('settings.developer.stakingRewardDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerLocalNotification(
                t('settings.developer.stakingRewardNotificationTitle'),
                t('settings.developer.stakingRewardNotificationBody'),
                {screen: 'staking'},
              )
            }
            testID="notif-staking"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.swapComplete')}
          description={t('settings.developer.swapCompleteDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerLocalNotification(
                t('settings.developer.swapCompleteNotificationTitle'),
                t('settings.developer.swapCompleteNotificationBody'),
                {screen: 'swap'},
              )
            }
            testID="notif-swap"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.governance')}
          description={t('settings.developer.governanceDescription')}
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerLocalNotification(
                t('settings.developer.voteRequiredNotificationTitle'),
                t('settings.developer.voteRequiredNotificationBody'),
                {screen: 'governance'},
              )
            }
            testID="notif-governance"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t('settings.developer.delayedSection')}>
        <SettingsRow
          label={t('settings.developer.delayedNotification')}
          description={t('settings.developer.delayedNotificationDescription')}
        >
          <Button
            label={t('settings.developer.send')}
            variant="secondary"
            size="sm"
            onPress={() =>
              triggerDelayedNotification(
                t('settings.developer.delayedNotificationTitle'),
                t('settings.developer.delayedNotificationBody'),
                {},
                5000,
              )
            }
            testID="notif-delayed"
          />
        </SettingsRow>
      </SettingsSection>

      {/* Permissions */}
      <SettingsSection title={t('settings.developer.permissionsSection')}>
        <SettingsRow
          label={t('settings.developer.requestPermission')}
          description={t('settings.developer.requestPermissionDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.request')}
            variant="secondary"
            size="sm"
            onPress={() => triggerNotificationsPermissionModal()}
            testID="notif-request-permission"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.checkStatus')}
          description={t('settings.developer.checkStatusDescription')}
        >
          <Button
            label={t('settings.developer.check')}
            variant="secondary"
            size="sm"
            onPress={async () => {
              const status = await getNotificationsAuthorizationStatus()
              Alert.alert(t('settings.developer.notificationStatusTitle'), status)
            }}
            testID="notif-check-status"
          />
        </SettingsRow>
      </SettingsSection>

      {/* Event History */}
      <SettingsSection title={t('settings.developer.eventHistorySection')}>
        <SettingsRow
          label={t('settings.developer.viewEvents')}
          description={t('settings.developer.viewEventsDescription')}
          showBorder
        >
          <Button
            label={t('settings.developer.view')}
            variant="secondary"
            size="sm"
            onPress={async () => {
              const events = await pushNotificationManager.events.read()
              const last = events[events.length - 1]
              const message =
                events.length === 0
                  ? t('settings.developer.noEventsStored')
                  : t('settings.developer.eventsCount', {
                      count: events.length,
                      title: last?.title ?? '—',
                      body: last?.body ?? '—',
                      date: last?.date ?? '—',
                    })
              Alert.alert(t('settings.developer.storedEventsTitle'), message)
            }}
            testID="notif-view-events"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.developer.clearEvents')}
          description={t('settings.developer.clearEventsDescription')}
        >
          <Button
            label={t('settings.developer.clear')}
            variant="secondary"
            isError
            size="sm"
            onPress={async () => {
              await pushNotificationManager.events.clear()
              Alert.alert(t('settings.developer.eventsClearedTitle'), t('settings.developer.eventsClearedMessage'))
            }}
            testID="notif-clear-events"
          />
        </SettingsRow>
      </SettingsSection>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
}))
