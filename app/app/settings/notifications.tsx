/**
 * Notifications settings screen.
 *
 * One toggle per category the app can actually switch off, persisted in `NotificationConfig` and
 * honoured by `shouldNotify` at the single inbox choke point.
 *
 * ⚠️ **These govern the in-app notification centre, not the OS banner.** A `notification` payload is
 * drawn by Android before the app is involved, so nothing here can suppress a banner for a push that
 * arrived while the app was closed — that is what the per-category Android channels are for, and why
 * the footer sends the user to system settings. Announcements are the exception: their toggle also
 * subscribes or unsubscribes the FCM topic, so it stops the delivery itself.
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {Linking, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsRow} from '../../src/components/SettingsRow'
import {Toggle} from '../../src/components/Toggle'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useNotificationPermissions} from '../../src/hooks/useNotificationPermissions'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {isNative} from '../../src/platform'
import {subscribeToCampaignsTopic, unsubscribeFromCampaignsTopic} from '../../src/platform/notification-tools'
import {useI18n} from '../../src/providers'
import {pushNotificationManager} from '../../src/services/notification-manager'
import {Trigger} from '../../src/services/notification-types'

/**
 * A category a user can switch off.
 *
 * ⚠️ **Every entry needs a real effect.** A toggle whose category nothing classifies into is a
 * switch that does nothing — which is why the kinds the service sends are mapped in
 * `triggerForKind`, and why there is no toggle here for a category with no producer.
 */
type Category = {
  readonly trigger: Trigger
  readonly icon: 'chat' | 'community' | 'campaign'
  readonly fillToken: 'primaryMuted' | 'successMuted' | 'warningMuted'
  readonly colorToken: 'primaryDefault' | 'successDefault' | 'warningDefault'
  readonly label: 'directMessages' | 'forumActivity' | 'marketingInsightsAlerts'
  readonly description: 'directMessagesSublabel' | 'forumActivitySublabel' | 'marketingInsightsSublabel'
  readonly testID: string
}

const ACTIVITY: readonly Category[] = [
  {
    trigger: Trigger.DirectMessage,
    icon: 'chat',
    fillToken: 'primaryMuted',
    colorToken: 'primaryDefault',
    label: 'directMessages',
    description: 'directMessagesSublabel',
    testID: 'notifications-dm',
  },
  {
    trigger: Trigger.Forum,
    icon: 'community',
    fillToken: 'successMuted',
    colorToken: 'successDefault',
    label: 'forumActivity',
    description: 'forumActivitySublabel',
    testID: 'notifications-forum',
  },
]

const ANNOUNCEMENTS: readonly Category[] = [
  {
    trigger: Trigger.Campaigns,
    icon: 'campaign',
    fillToken: 'warningMuted',
    colorToken: 'warningDefault',
    label: 'marketingInsightsAlerts',
    description: 'marketingInsightsSublabel',
    testID: 'notifications-campaigns',
  },
]

const ALL: readonly Category[] = [...ACTIVITY, ...ANNOUNCEMENTS]

function NotificationIconTile({
  icon,
  fillToken,
  colorToken,
}: Omit<Category, 'trigger' | 'label' | 'description' | 'testID'>) {
  return (
    <View style={styles.iconTile}>
      <ChamferBackground size="auto" fillToken={fillToken} />
      <UniIcon name={icon} width={17} height={17} uniProps={(theme) => ({color: theme.colors[colorToken]})} />
    </View>
  )
}

export default function NotificationsScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {hasPermission, isLoading: permLoading, refreshStatus} = useNotificationPermissions()

  const [enabled, setEnabled] = useState<Partial<Record<Trigger, boolean>>>({})

  useEffect(() => {
    if (!isNative) return
    pushNotificationManager.config
      .read()
      .then((cfg) => {
        setEnabled(Object.fromEntries(ALL.map((c) => [c.trigger, cfg[c.trigger].notify])))
      })
      .catch((e) => {
        logger.warn('Failed to read notification prefs; the toggles show their defaults', {
          origin: 'settings/notifications',
          error: String(e),
        })
      })
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (!isNative) return
      refreshStatus()
    }, [refreshStatus]),
  )

  const showPreferenceToast = useCallback(
    (name: string, enabled: boolean) => {
      showToast({
        variant: enabled ? 'success' : 'info',
        message: t(
          enabled ? 'settings.notifications.preferenceTurnedOn' : 'settings.notifications.preferenceTurnedOff',
          {
            name,
          },
        ),
        duration: 2000,
      })
    },
    [showToast, t],
  )

  const handleChange = useCallback(
    async (category: Category, next: boolean) => {
      setEnabled((current) => ({...current, [category.trigger]: next}))
      try {
        await pushNotificationManager.config.save({[category.trigger]: {notify: next}})
        // Announcements are the one category whose delivery we can stop at source, because they
        // arrive on a broadcast topic rather than this device's own token.
        if (category.trigger === Trigger.Campaigns) {
          await (next ? subscribeToCampaignsTopic() : unsubscribeFromCampaignsTopic())
        }
        showPreferenceToast(t(`settings.notifications.${category.label}`), next)
      } catch (e) {
        logger.error('Failed to update a notification preference', {
          origin: 'settings/notifications',
          trigger: category.trigger,
          cause: e,
        })
        // Put the switch back where it was: leaving it showing a preference that was not saved is
        // the same lie as a button whose handler does nothing.
        setEnabled((current) => ({...current, [category.trigger]: !next}))
      }
    },
    [showPreferenceToast, t],
  )

  const renderCategory = (category: Category) => (
    <SettingsRow
      key={category.trigger}
      label={t(`settings.notifications.${category.label}`)}
      description={t(`settings.notifications.${category.description}`)}
      leftSlot={
        <NotificationIconTile icon={category.icon} fillToken={category.fillToken} colorToken={category.colorToken} />
      }
      testID={category.testID}
    >
      <Toggle
        checked={enabled[category.trigger] ?? true}
        onChange={(next) => handleChange(category, next)}
        testID={`${category.testID}-toggle`}
      />
    </SettingsRow>
  )

  const handleOpenSystemSettings = useCallback(() => {
    if (isNative) {
      void Linking.openSettings()
    }
  }, [])

  const showPermissionBanner = isNative && !permLoading && !hasPermission

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.introNotice}>
        <ChamferBackground size="auto" fillToken="primaryMuted" borderToken="primaryBorder" />
        <View style={styles.introIcon}>
          <ChamferBackground size="auto" fillToken="primaryDefault" />
          {/* Inverse, not `primaryDefault`: the tile it sits on is that colour, so it drew invisible. */}
          <UniIcon name="bell" width={18} height={18} uniProps={(theme) => ({color: theme.colors.primaryInverse})} />
        </View>
        <View style={styles.introBody}>
          <Typography variant="bodyMd_medium" style={styles.introTitle}>
            {t('settings.notifications.introTitle')}
          </Typography>
          <Typography variant="bodySm_regular" style={styles.introText}>
            {t('settings.notifications.introDescription')}
          </Typography>
        </View>
      </View>

      <SettingsGroup label={t('settings.notifications.activitySection')}>{ACTIVITY.map(renderCategory)}</SettingsGroup>

      <SettingsGroup label={t('settings.notifications.appUpdatesSection')}>
        {ANNOUNCEMENTS.map(renderCategory)}
      </SettingsGroup>

      {showPermissionBanner ? (
        <Pressable
          style={styles.permissionBanner}
          onPress={handleOpenSystemSettings}
          accessibilityRole="button"
          accessibilityLabel={t('settings.notifications.permissionOffTitle')}
          testID="notifications-permission-banner"
        >
          <ChamferBackground size="auto" fillToken="errorMuted" />
          <UniIcon name="alert" size="md" uniProps={(theme) => ({color: theme.colors.errorDefault})} />
          <View style={styles.permissionText}>
            <Typography variant="bodyMd_medium" style={styles.permissionTitle}>
              {t('settings.notifications.permissionOffTitle')}
            </Typography>
            <Typography variant="bodySm_regular" style={styles.permissionDescription}>
              {t('settings.notifications.permissionOffDescription')}
            </Typography>
          </View>
          <Typography variant="bodySm_bold" style={styles.permissionAction}>
            {t('settings.notifications.openSettings')}
          </Typography>
        </Pressable>
      ) : null}

      <Pressable
        style={styles.footerNote}
        onPress={handleOpenSystemSettings}
        disabled={!isNative}
        accessibilityRole="button"
        accessibilityLabel={t('settings.notifications.systemSettingsNote')}
      >
        <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderSubtle" />
        <View style={styles.footerIcon}>
          <UniIcon name="info" width={14} height={14} uniProps={(theme) => ({color: theme.colors.textMuted})} />
        </View>
        <Typography variant="bodySm_regular" style={styles.footerText}>
          {t('settings.notifications.systemSettingsNoteFirstPart')}
          <Typography variant="bodySm_bold" style={styles.linkAction}>
            {t('settings.notifications.systemSettingsLink')}
          </Typography>
          {t('settings.notifications.systemSettingsNoteSecondPart')}
        </Typography>
      </Pressable>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    paddingBottom: spacing.spacing32,
    gap: spacing.spacing20,
  },
  introNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.spacing12,
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing12,
  },
  introIcon: {
    marginTop: spacing.spacing4,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  introBody: {
    flex: 1,
    minWidth: 0,
    gap: spacing.spacing2,
  },
  introTitle: {
    color: colors.textDefault,
  },
  introText: {
    color: colors.textAlternative,
  },
  iconTile: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    padding: spacing.spacing12,
  },
  permissionText: {
    flex: 1,
    gap: spacing.spacing2,
  },
  permissionTitle: {
    color: colors.textDefault,
  },
  permissionDescription: {
    color: colors.textAlternative,
  },
  permissionAction: {
    color: colors.errorDefault,
  },
  linkAction: {
    color: colors.textDefault,
  },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.spacing8,
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing12,
  },
  footerIcon: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  footerText: {
    flex: 1,
    color: colors.textAlternative,
    lineHeight: 18,
  },
}))
