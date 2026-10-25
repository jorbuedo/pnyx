/**
 * Notifications inbox screen.
 *
 * Displays all received push notifications with read/unread state.
 * Marks a notification as read when the user presses it.
 * New notifications are added in real-time via pushNotificationManager.newEvents$.
 *
 * When the user has denied notification permissions, shows a prompt
 * with a button to re-request or open system settings.
 */

import {Stack, useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AppState, type AppStateStatus, FlatList, Linking, Pressable, ScrollView, View} from 'react-native'
import Animated, {FadeIn, FadeOut, LinearTransition, SlideInUp, SlideOutUp} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../src/components/Buttons'
import {ChamferBackground} from '../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../src/components/SafeAreaViewWrapper'
import {SwipeToDeleteRow} from '../src/components/SwipeToDeleteRow'
import {Typography} from '../src/components/Typography'
import {UniIcon, type UniIconName} from '../src/components/UniIcon'
import {useNotificationPermissions} from '../src/hooks/useNotificationPermissions'
import {logger} from '../src/logger'
import {isNative} from '../src/platform'
import {handlePushNavigation} from '../src/platform/notification-tools'
import {useI18n} from '../src/providers'
import {pushNotificationManager} from '../src/services/notification-manager'
import type {PushEvent} from '../src/services/notification-types'
import {parseScreenTarget, Trigger} from '../src/services/notification-types'

type FilterKey = 'all' | 'unread' | 'tx' | 'campaigns'
type TranslateFn = ReturnType<typeof useI18n>['t']

type SectionHeader = {_type: 'header'; label: string; key: string}
type SectionRow = {_type: 'row'; event: PushEvent}
type ListItem = SectionHeader | SectionRow

function formatRelativeTime(isoDate: string, t: TranslateFn, locale: string): string {
  const eventDate = new Date(isoDate)
  if (Number.isNaN(eventDate.getTime())) {
    logger.warn('[notifications] invalid isoDate on formatRelativeTime', {origin: 'notifications', isoDate})
    return ''
  }
  const diff = Date.now() - eventDate.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('notifications.timeJustNow')
  if (minutes < 60) return t('notifications.timeMinutesAgo', {count: minutes})
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('notifications.timeHoursAgo', {count: hours})
  const days = Math.floor(hours / 24)
  if (days < 7) return t('notifications.timeDaysAgo', {count: days})
  return eventDate.toLocaleDateString(locale, {month: 'short', day: 'numeric'})
}

function getDateGroupLabel(isoDate: string, t: TranslateFn, locale: string): string {
  const eventDate = new Date(isoDate)
  if (Number.isNaN(eventDate.getTime())) {
    logger.warn('[notifications] invalid isoDate on getDateGroupLabel', {origin: 'notifications', isoDate})
    return ''
  }
  const now = new Date()
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayMidnight = new Date(todayMidnight.getTime() - 86_400_000)
  const eventMidnight = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate())
  if (eventMidnight.getTime() === todayMidnight.getTime()) return t('notifications.sectionToday')
  if (eventMidnight.getTime() === yesterdayMidnight.getTime()) return t('notifications.sectionYesterday')
  const includeYear = eventDate.getFullYear() !== now.getFullYear()
  return eventDate.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear && {year: 'numeric'}),
  })
}

function groupEventsByDate(events: PushEvent[], t: TranslateFn, locale: string): ListItem[] {
  const result: ListItem[] = []
  let lastLabel: string | null = null
  for (const event of events) {
    const label = getDateGroupLabel(event.date, t, locale)
    if (label !== lastLabel) {
      result.push({_type: 'header', label, key: `header-${label}`})
      lastLabel = label
    }
    result.push({_type: 'row', event})
  }
  return result
}

type NotificationRowProps = {
  event: PushEvent
  onPress: (event: PushEvent) => void
  onDelete: (id: number) => void
  locale: string
}

const iconNameMap: Record<string, UniIconName> = {
  [Trigger.Transaction]: 'arrows',
  [Trigger.Campaigns]: 'campaign',
  [Trigger.DirectMessage]: 'chat',
  [Trigger.Forum]: 'community',
  [Trigger.Push]: 'bell',
}

export function NotificationRow({event, onPress, onDelete, locale}: NotificationRowProps) {
  const {t} = useI18n()

  rowStyles.useVariants({trigger: event.trigger})

  const iconName = iconNameMap[event.trigger] || 'bell'

  return (
    <SwipeToDeleteRow onDelete={() => onDelete(event.id)} deleteTestID={`notification-delete-${event.id}`}>
      <Pressable
        onPress={() => onPress(event)}
        testID={`notification-row-${event.id}`}
        style={({pressed}) => [styles.row, !event.isRead && styles.rowUnread, pressed && styles.rowPressed]}
      >
        <View style={[styles.iconCircle, rowStyles.circleStyle]}>
          <UniIcon name={iconName} size="sm" color={rowStyles.iconColorStyle.color} />
        </View>

        <View style={styles.textContent}>
          <Typography variant="bodyMd_medium" numberOfLines={1}>
            {event.title || t('notifications.fallbackTitle')}
          </Typography>
          {event.body ? (
            <Typography variant="bodySm_regular" numberOfLines={2} style={styles.bodyText}>
              {event.body}
            </Typography>
          ) : null}
          <Typography variant="bodyXs_regular" style={styles.timestampText}>
            {formatRelativeTime(event.date, t, locale)}
          </Typography>
        </View>

        <View style={styles.dotColumn}>{!event.isRead && <View style={styles.unreadDot} />}</View>
      </Pressable>
    </SwipeToDeleteRow>
  )
}

const rowStyles = StyleSheet.create(({colors, colorAlpha}) => ({
  circleStyle: {
    variants: {
      trigger: {
        [Trigger.Push]: {
          backgroundColor: `${colors.primaryAlternative}${colorAlpha[24]}`,
        },
        [Trigger.Transaction]: {
          backgroundColor: `${colors.warningMuted}${colorAlpha[24]}`,
        },
        [Trigger.Campaigns]: {
          backgroundColor: `${colors.successMuted}${colorAlpha[24]}`,
        },
        [Trigger.DirectMessage]: {
          backgroundColor: `${colors.primaryMuted}${colorAlpha[24]}`,
        },
        [Trigger.Forum]: {
          backgroundColor: `${colors.successMuted}${colorAlpha[24]}`,
        },
        default: {
          backgroundColor: `${colors.primaryAlternative}${colorAlpha[24]}`,
        },
      },
    },
  },
  iconColorStyle: {
    variants: {
      trigger: {
        [Trigger.Push]: {
          color: colors.primaryDefault,
        },
        [Trigger.Transaction]: {
          color: colors.warningDefault,
        },
        [Trigger.Campaigns]: {
          color: colors.successDefault,
        },
        [Trigger.DirectMessage]: {
          color: colors.primaryDefault,
        },
        [Trigger.Forum]: {
          color: colors.successDefault,
        },
        default: {
          color: colors.primaryDefault,
        },
      },
    },
  },
}))

export default function NotificationsList() {
  const {t, locale} = useI18n()
  const {hasPermission, requestPermission, refreshStatus} = useNotificationPermissions()
  const [events, setEvents] = useState<PushEvent[]>([])
  // Unread is the default, not just the first pill: opening the centre is a question about what is
  // waiting, and answering it with the full history buries the answer.
  const [activeFilter, setActiveFilter] = useState<FilterKey>('unread')

  const filteredEvents = useMemo(() => {
    switch (activeFilter) {
      case 'unread':
        return events.filter((e) => !e.isRead)
      case 'tx':
        return events.filter((e) => e.trigger === Trigger.Transaction)
      case 'campaigns':
        return events.filter((e) => e.trigger === Trigger.Campaigns)
      default:
        return events
    }
  }, [events, activeFilter])

  const unreadCount = useMemo(() => events.filter((e) => !e.isRead).length, [events])

  const groupedItems = useMemo(() => groupEventsByDate(filteredEvents, t, locale), [filteredEvents, t, locale])

  const filterTabs = useMemo(
    () =>
      [
        // Unread leads: it is the only one of the three that answers "is there anything for me".
        {key: 'unread', label: t('notifications.filterUnread')},
        {key: 'all', label: t('notifications.filterAll')},
        {key: 'campaigns', label: t('notifications.filterCampaigns')},
      ] as const,
    [t],
  )

  useFocusEffect(
    useCallback(() => {
      refreshStatus()
      pushNotificationManager.events
        .read()
        .then(setEvents)
        .catch((e) => {
          logger.warn('[notifications] failed to read the inbox; the list stays as it was', {
            origin: 'notifications',
            error: String(e),
          })
        })
    }, [refreshStatus]),
  )

  const appStateRef = useRef(AppState.currentState)
  useEffect(() => {
    if (!isNative) return
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        refreshStatus()
      }
      appStateRef.current = nextState
    }
    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [refreshStatus])

  useEffect(() => {
    if (!isNative) return
    return pushNotificationManager.newEvents$.subscribe((event) => {
      setEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)])
    })
  }, [])

  const handlePress = useCallback((event: PushEvent) => {
    const parsedScreen = parseScreenTarget(event.data.screen)
    logger.debug('[notifications] tap', {
      origin: 'notifications',
      id: event.id,
      trigger: event.trigger,
      title: event.title,
      body: event.body,
      data: event.data,
      dataKeys: Object.keys(event.data),
      parsedScreen,
    })
    pushNotificationManager.events
      .markAsRead(event.id)
      .then(() => {
        setEvents((prev) => prev.map((e) => (e.id === event.id ? {...e, isRead: true} : e)))
      })
      .catch((e) => {
        logger.warn('[notifications] failed to mark one read; it stays unread', {
          origin: 'notifications',
          id: event.id,
          error: String(e),
        })
      })
    handlePushNavigation({...event.data, trigger: event.trigger}, parsedScreen)
  }, [])

  const handleEnableNotifications = useCallback(async () => {
    const granted = await requestPermission()
    if (!granted) {
      await Linking.openSettings()
    }
  }, [requestPermission])

  const handleMarkAllAsRead = useCallback(() => {
    pushNotificationManager.events.markAllAsRead().catch((e) => {
      // The rows are already painted read, so a failure here makes the screen disagree with storage.
      logger.warn('[notifications] failed to mark all read; the screen now disagrees with storage', {
        origin: 'notifications',
        error: String(e),
      })
    })
    setEvents((prev) => prev.map((e) => ({...e, isRead: true})))
  }, [])

  const handleDelete = useCallback((id: number) => {
    pushNotificationManager.events.remove(id).catch((e) => {
      logger.warn('[notifications] failed to delete one; it returns on the next read', {
        origin: 'notifications',
        id,
        error: String(e),
      })
    })
    setEvents((prev) => prev.filter((e) => e.id !== id))
  }, [])

  const renderHeaderRight = useCallback(
    () =>
      unreadCount > 0 ? (
        <Pressable
          onPress={handleMarkAllAsRead}
          hitSlop={8}
          testID="notifications-mark-all-read-btn"
          style={styles.headerRightBtn}
        >
          <Typography variant="bodySm_medium" style={styles.markAllReadText}>
            {t('notifications.markAllRead')}
          </Typography>
        </Pressable>
      ) : null,
    [unreadCount, handleMarkAllAsRead, t],
  )

  const renderItem = useCallback(
    ({item}: {item: ListItem}) => {
      if (item._type === 'header') {
        return (
          <Animated.View
            layout={LinearTransition.duration(200)}
            entering={FadeIn.delay(200)}
            exiting={FadeOut.duration(200)}
          >
            <Typography variant="bodyXs_regular" style={styles.dateHeader}>
              {item.label.toLocaleUpperCase(locale)}
            </Typography>
          </Animated.View>
        )
      }
      return (
        <Animated.View
          layout={LinearTransition.duration(200)}
          entering={FadeIn.delay(200)}
          exiting={FadeOut.duration(200)}
        >
          <NotificationRow event={item.event} onPress={handlePress} onDelete={handleDelete} locale={locale} />
        </Animated.View>
      )
    },
    [handlePress, handleDelete, locale],
  )

  if (!isNative) {
    return (
      <SafeAreaViewWrapper edges={['top']} style={styles.safeArea}>
        <View style={styles.deniedState} testID="notifications-permission-denied">
          <Typography variant="headingMd" style={styles.deniedTitle}>
            {t('notifications.webUnavailableTitle')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.bodyTextCenter}>
            {t('notifications.webUnavailableMessage')}
          </Typography>
        </View>
      </SafeAreaViewWrapper>
    )
  }

  if (!hasPermission) {
    return (
      <SafeAreaViewWrapper edges={['top']} style={styles.safeArea}>
        <View style={styles.deniedState} testID="notifications-permission-denied">
          <Typography variant="headingMd" style={styles.deniedTitle}>
            {t('notifications.permissionDeniedTitle')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.bodyTextCenter}>
            {t('notifications.permissionDeniedMessage')}
          </Typography>
          <Button
            label={t('notifications.enableNotifications')}
            onPress={handleEnableNotifications}
            testID="notifications-enable-btn"
          />
        </View>
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper edges={[]} style={styles.safeArea} noPadding>
      <Stack.Screen options={{headerRight: renderHeaderRight}} />

      <FlatList
        data={groupedItems}
        renderItem={renderItem}
        keyExtractor={(item, index) =>
          item._type === 'header' ? `${item.key}-${index}` : `row-${item.event.id}-${index}`
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
        ListHeaderComponent={
          <Animated.View style={styles.filterTabsContainer(unreadCount > 0)} layout={LinearTransition.duration(200)}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterTabsContent}
              style={styles.filterTabsScroll}
              testID="notifications-filter-tabs"
            >
              {filterTabs.map(({key, label}) => {
                const isActive = activeFilter === key
                return (
                  <Pressable key={key} onPress={() => setActiveFilter(key as FilterKey)} style={styles.filterTab}>
                    <ChamferBackground
                      size="auto"
                      {...(isActive ? {fillToken: 'primaryDefault' as const} : {})}
                      borderToken={isActive ? 'primaryDefault' : 'borderDefaultWeak'}
                    />
                    <Typography variant="bodySm_medium" style={styles.filterTabLabelActive(isActive)}>
                      {label}
                    </Typography>
                  </Pressable>
                )
              })}
            </ScrollView>

            {unreadCount > 0 ? (
              <Animated.View
                style={styles.unreadBanner}
                testID="notifications-unread-banner"
                entering={SlideInUp}
                exiting={SlideOutUp}
              >
                <View style={styles.unreadBannerDot} />
                <Typography variant="bodySm_medium" style={styles.unreadBannerText}>
                  {t('notifications.unreadBanner', {count: unreadCount})}
                </Typography>
              </Animated.View>
            ) : null}
          </Animated.View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.emptyIconCircle} testID="notifications-empty-icon">
              <UniIcon name="bell" size="lg" uniProps={(theme) => ({color: theme.colors.textMuted})} />
            </View>
            <Typography variant="headingMd" style={styles.emptyTitle} testID="notifications-empty-title">
              {t('notifications.emptyTitle')}
            </Typography>
            <Typography variant="bodyMd_regular" style={styles.bodyTextCenter}>
              {t('notifications.emptySubtitle')}
            </Typography>
          </View>
        }
        testID="notifications-list"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing, colors, borderRadius}, rt) => ({
  safeArea: {
    flex: 1,
  },

  // ── Header ───────────────────────────────────────────────────────────────
  headerRightBtn: {
    paddingHorizontal: spacing.spacing4,
  },
  markAllReadText: {
    color: colors.primaryDefault,
  },

  // ── Filter tabs ──────────────────────────────────────────────────────────
  filterTabsScroll: {
    flexGrow: 0,
    zIndex: 2,
  },
  filterTabsContent: {
    flexDirection: 'row',
    gap: spacing.spacing6,
    paddingHorizontal: spacing.spacing16,
    paddingVertical: spacing.spacing12,
    backgroundColor: colors.backgroundDefault,
    zIndex: 2,
  },
  filterTab: {
    paddingVertical: 7,
    paddingHorizontal: spacing.spacing16,
    flexShrink: 0,
  },
  filterTabLabelActive: (isActive: boolean) => ({
    color: isActive ? colors.primaryInverse : colors.textAlternative,
  }),

  // ── Unread banner ────────────────────────────────────────────────────────
  unreadBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing8,
    paddingVertical: spacing.spacing8 + 2,
    paddingHorizontal: spacing.spacing16,
    borderBottomWidth: 1,
    borderBottomColor: colors.primaryDefault,
    backgroundColor: colors.backgroundHover,
    zIndex: 1,
  },
  unreadBannerDot: {
    width: 8,
    height: 8,
    borderRadius: borderRadius.roundedCircle,
    backgroundColor: colors.primaryDefault,
    flexShrink: 0,
  },
  unreadBannerText: {
    color: colors.primaryDefault,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  rowUnread: {
    backgroundColor: colors.backgroundHover,
    borderLeftWidth: 3,
    borderLeftColor: colors.primaryDefault,
    paddingLeft: spacing.spacing16 - 3,
  },
  rowPressed: {
    opacity: 0.7,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  textContent: {
    flex: 1,
    gap: spacing.spacing4,
    minWidth: 0,
  },
  bodyText: {
    color: colors.textAlternative,
  },
  timestampText: {
    color: colors.textMuted,
  },
  dotColumn: {
    width: 10,
    alignItems: 'center',
    paddingTop: spacing.spacing4,
    flexShrink: 0,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: borderRadius.roundedCircle,
    backgroundColor: colors.primaryDefault,
  },

  // ── Date section header ──────────────────────────────────────────────────
  dateHeader: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    paddingBottom: spacing.spacing8,
    color: colors.textMuted,
    letterSpacing: 0.8,
  },

  // ── Empty state ──────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing.spacing32,
    paddingTop: spacing.spacing80,
    gap: spacing.spacing8,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.spacing12,
    backgroundColor: colors.backgroundAlternative,
  },
  emptyTitle: {
    textAlign: 'center',
  },
  bodyTextCenter: {
    color: colors.textAlternative,
    textAlign: 'center',
  },

  // ── List ─────────────────────────────────────────────────────────────────
  listContent: {
    flexGrow: 1,
    paddingBottom: rt.insets.bottom + spacing.spacing16,
  },

  // ── Permission denied / web unavailable ──────────────────────────────────
  deniedState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.spacing24,
    gap: spacing.spacing16,
  },
  deniedTitle: {
    textAlign: 'center',
  },
  filterTabsContainer: (hasUnread: boolean) => ({
    backgroundColor: colors.backgroundDefault,
    borderBottomWidth: 1,
    borderBottomColor: hasUnread ? 'transparent' : colors.borderDefaultWeak,
  }),
}))
