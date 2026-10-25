/**
 * Shared top bar for the tab shell — spans the top under the status bar:
 * the IDENTITY (identicon derived from the identity address + identity display
 * name + network tag) on the left (opens the Id tab), and hold-to-lock, QR
 * scanner and notification bell on the right. Shows the identity, never the
 * selected funds wallet (identity/wallet split).
 *
 * Replaces the former bottom `UserBar`, whose slot the bottom tab bar now owns
 * (see docs/mobile-shell-plan.md phase 6, product/STATUS.md nav reshape). Rendered
 * as the `Tabs` navigator header so every tab shares one instance.
 *
 * @module
 */

import {router} from 'expo-router'
import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useUnreadNotifications} from '../hooks/useUnreadNotifications'
import {formatGroupedInteger, resolveNumberLocale} from '../i18n/number-format'
import {useI18n, usePnyxSession} from '../providers'
import {ButtonIcon} from './Buttons'
import {ChamferBackground} from './Chamfer'
import {IdentityAvatar} from './IdentityAvatar'
import {LockButton} from './LockButton'
import {NetworkBadge} from './NetworkBadge'
import {Typography} from './Typography'

export function AppTopBar() {
  const {t, locale} = useI18n()
  const unread = useUnreadNotifications()
  const {identity} = usePnyxSession()
  const [isAccountPressed, setIsAccountPressed] = useState(false)

  return (
    <View style={styles.bar}>
      <Pressable
        onPress={() => router.navigate('/id')}
        accessibilityRole="button"
        accessibilityLabel={t('common.nav.id')}
        onPressIn={() => setIsAccountPressed(true)}
        onPressOut={() => setIsAccountPressed(false)}
        style={styles.account}
        testID="top-bar-identity"
      >
        {isAccountPressed && <ChamferBackground size="auto" fillToken="backgroundHover" />}
        <IdentityAvatar size={32} pnyxId={identity?.pnyxId} />
      </Pressable>
      {/* Absolutely centered so the pill sits mid-header whatever the avatar
          slot's width; box-none keeps the identity and actions tappable. */}
      <View style={styles.networkSlot} pointerEvents="box-none">
        <NetworkBadge />
      </View>
      <View style={styles.actions}>
        <LockButton />
        <ButtonIcon
          icon="scan"
          variant="naked"
          size="md"
          onPress={() => router.push('/scan')}
          containerProps={{accessibilityLabel: t('common.nav.scanQrCode')}}
          testID="top-bar-scan"
        />
        <View>
          <ButtonIcon
            icon="bell"
            variant="naked"
            size="md"
            onPress={() => router.push('/notifications')}
            containerProps={{accessibilityLabel: t('common.nav.notifications')}}
            testID="top-bar-notifications"
          />
          {unread > 0 && (
            <View style={styles.unread} testID="top-bar-notifications-unread">
              <Typography variant="bodyXs_medium" style={styles.unreadText}>
                {unread > 99
                  ? t('common.countOverflow', {max: 99})
                  : formatGroupedInteger(unread, resolveNumberLocale(locale))}
              </Typography>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  unread: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.errorDefault,
  },
  unreadText: {
    color: theme.colors.primaryInverse,
    lineHeight: 16,
  },
  bar: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: rt.insets.top + theme.spacing.spacing8,
    paddingBottom: theme.spacing.spacing8,
    backgroundColor: theme.colors.backgroundNavigation,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    flexShrink: 1,
    paddingVertical: theme.spacing.spacing4,
    paddingHorizontal: theme.spacing.spacing8,
  },
  networkSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: rt.insets.top + theme.spacing.spacing8,
    bottom: theme.spacing.spacing8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
  },
}))
