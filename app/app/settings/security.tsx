/**
 * Security settings.
 *
 * Unlock is still the OS biometric prompt with device-passcode fallback — the
 * enclave remains the root of trust and the PIN never protects seed material.
 * The PIN is a *selector*: it decides which profile the app opens.
 *
 * What renders here is filtered by the active profile (`visibleLockSettings`).
 * From the decoy this shows a plain PIN setup with no second-profile section
 * and no way to turn the PIN off — see `docs/DISTRESS_PROFILE_PLAN.md` for why
 * that asymmetry is the least-bad option.
 *
 * @module
 */

import {router, useFocusEffect} from 'expo-router'
import {useCallback, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../src/components/Chamfer'
import {Modal} from '../../src/components/Modal/Modal'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SegmentedControl, type SegmentedControlOption} from '../../src/components/SegmentedControl'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsRow} from '../../src/components/SettingsRow'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {type AutoLockValue, useAutoLockTimer} from '../../src/hooks/useAutoLockTimer'
import {useToast} from '../../src/hooks/useToast'
import {useDismissNoticeOnFocus} from '../../src/notices'
import {useI18n} from '../../src/providers'
import {isDecoySetupPendingSync} from '../../src/services/profile/decoy-setup'
import {clearDecoyAndWipe, disablePin, setPinMode, visibleLockSettings} from '../../src/services/profile/lock-settings'
import {type LockConfig, readLockConfig} from '../../src/services/profile/pin-config'
import type {PinMode} from '../../src/services/profile/pin-required'

export default function SecurityScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()

  useDismissNoticeOnFocus('security-settings-unseen')

  const {value: autoLock, setAutoLock} = useAutoLockTimer()

  const [config, setConfig] = useState<LockConfig | undefined>(undefined)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [confirmRemoveDecoy, setConfirmRemoveDecoy] = useState(false)
  const reload = useCallback(() => {
    void readLockConfig().then(setConfig)
  }, [])
  // On focus, not on mount: the PIN setup flow returns here with `router.back()`,
  // which leaves this screen mounted. A mount-only read left the section still
  // offering "Require a PIN" after one had just been saved.
  useFocusEffect(reload)

  const visible = visibleLockSettings(config)
  const decoySetupPending = isDecoySetupPendingSync()

  const pinModeOptions: readonly SegmentedControlOption<PinMode>[] = [
    {value: 'everyUnlock', label: t('settings.security.pin.whenAskedEveryUnlock')},
    {value: 'coldStart', label: t('settings.security.pin.whenAskedColdStart')},
    {value: 'armed', label: t('settings.security.pin.whenAskedArmed')},
  ]

  const modeSublabel =
    visible.mode === 'everyUnlock'
      ? t('settings.security.pin.whenAskedEveryUnlockSublabel')
      : visible.mode === 'armed'
        ? t('settings.security.pin.whenAskedArmedSublabel')
        : t('settings.security.pin.whenAskedColdStartSublabel')

  const handleModeChange = useCallback(
    (mode: PinMode) => {
      void setPinMode(mode, t('settings.security.pin.authRequired')).then((result) => {
        if (!result.ok) {
          showToast({message: t('settings.security.pin.authFailed')})
          return
        }
        reload()
      })
    },
    [reload, showToast, t],
  )

  const handleDisable = useCallback(() => {
    setConfirmDisable(false)
    void disablePin(t('settings.security.pin.authRequired')).then((result) => {
      showToast({
        message: result.ok ? t('settings.security.pin.disabledSuccess') : t('settings.security.pin.authFailed'),
      })
      reload()
    })
  }, [reload, showToast, t])

  const handleRemoveDecoy = useCallback(() => {
    setConfirmRemoveDecoy(false)
    void clearDecoyAndWipe(t('settings.security.pin.authRequired')).then((result) => {
      showToast({
        message: result.ok ? t('settings.security.decoy.removedSuccess') : t('settings.security.pin.authFailed'),
      })
      reload()
    })
  }, [reload, showToast, t])

  const autoLockOptions: readonly SegmentedControlOption<AutoLockValue>[] = [
    {value: 'immediately', label: t('settings.security.autoLockShortImmediately')},
    {value: '1m', label: t('settings.security.autoLockShortOneMinute')},
    {value: '5m', label: t('settings.security.autoLockShortFiveMinutes')},
    {value: '15m', label: t('settings.security.autoLockShortFifteenMinutes')},
    {value: '30m', label: t('settings.security.autoLockShortThirtyMinutes')},
  ]

  const autoLockSublabel =
    autoLock === 'immediately'
      ? t('settings.security.autoLockSublabelImmediately')
      : t('settings.security.autoLockSublabel', {
          value: autoLockOptions.find((o) => o.value === autoLock)?.label ?? '5m',
        })

  // biome-ignore lint/correctness/useExhaustiveDependencies: autoLockOptions is not a dependency of the callback
  const handleAutoLockChange = useCallback(
    (v: AutoLockValue) => {
      void setAutoLock(v)
      showToast({
        message: t('settings.security.autoLockChangedSuccess', {
          value: autoLockOptions.find((o) => o.value === v)?.label ?? t('settings.security.autoLockShortFiveMinutes'),
        }),
      })
    },
    [setAutoLock, t, showToast],
  )

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <SettingsGroup label={t('settings.security.sections.appAccess')}>
        {/* PIN first: it is the gate. Auto-lock below is a timing knob on it.
            Both answer the same question — how you get into the app — which is
            why they share a section rather than each having one. The PIN is a
            profile selector, not a second lock on the seed. */}
        {!visible.configured ? (
          <SettingsRow
            label={t('settings.security.pin.enable')}
            description={t('settings.security.pin.enableSublabel')}
            leftIcon="lock"
            onPress={() => router.push('/settings/pin-setup?kind=real&mode=coldStart')}
            showBorder
            testID="security-enable-pin"
          />
        ) : (
          <>
            <View style={[styles.stackedRow, styles.stackedRowDivided]}>
              <View style={styles.stackedRowBody}>
                <Typography variant="bodyMd_medium" style={styles.rowLabel}>
                  {t('settings.security.pin.whenAsked')}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.rowDescription}>
                  {modeSublabel}
                </Typography>
              </View>
              <SegmentedControl<PinMode>
                options={pinModeOptions}
                value={visible.mode ?? 'coldStart'}
                onChange={handleModeChange}
                testID="pin-mode-segmented"
              />
            </View>
            <SettingsRow
              label={t('settings.security.pin.change')}
              leftIcon="lock"
              onPress={() => router.push(`/settings/pin-setup?kind=real&mode=${visible.mode ?? 'coldStart'}`)}
              showBorder
              testID="security-change-pin"
            />
            {/* Absent inside the decoy: turning the gate off from there would
                either strand the real profile or keep prompting anyway, and
                the second would be the app lying about what the switch did. */}
            {visible.canDisable && (
              <SettingsRow
                label={t('settings.security.pin.disable')}
                leftIcon="lock"
                destructive
                onPress={() => setConfirmDisable(true)}
                showBorder
                testID="security-disable-pin"
              />
            )}
          </>
        )}

        <View style={styles.stackedRow}>
          <View style={styles.stackedRowHead}>
            <View style={styles.iconBadge}>
              <ChamferBackground size="auto" fillToken="accentMuted" />
              <UniIcon name="clock" size="sm" uniProps={(theme) => ({color: theme.colors.accentLight})} />
            </View>
            <View style={styles.stackedRowBody}>
              <Typography variant="bodyMd_medium" style={styles.rowLabel}>
                {t('settings.security.autoLockTimer')}
              </Typography>
              <Typography variant="bodySm_regular" style={styles.rowDescription}>
                {autoLockSublabel}
              </Typography>
            </View>
          </View>
          <SegmentedControl<AutoLockValue>
            options={autoLockOptions}
            value={autoLock}
            onChange={handleAutoLockChange}
            testID="auto-lock-segmented"
          />
        </View>
      </SettingsGroup>

      {/* Second profile + emergency code. Rendered only from the real profile,
          so the decoy never discloses that either exists. */}
      {visible.configured && visible.canManageDecoy && (
        <>
          <SettingsGroup label={t('settings.security.decoy.sectionTitle')}>
            <View style={styles.stackedRow}>
              <Typography variant="bodySm_regular" style={styles.rowDescription}>
                {t('settings.security.decoy.description')}
              </Typography>
              <Typography variant="bodySm_regular" style={styles.rowDescription}>
                {t('settings.security.decoy.limitation')}
              </Typography>
            </View>
            {/* Setting the PIN only creates the namespace — the profile is still
                empty until the user enters it and onboards, and nothing else in
                the app would tell them that. */}
            <SettingsRow
              label={
                visible.decoyConfigured ? t('settings.security.decoy.configured') : t('settings.security.decoy.setUp')
              }
              description={
                visible.decoyConfigured
                  ? decoySetupPending
                    ? t('settings.security.decoy.finishHint')
                    : t('settings.security.decoy.fundHint')
                  : undefined
              }
              leftIcon="lock"
              onPress={() => router.push('/settings/pin-setup?kind=decoy')}
              showBorder={visible.decoyConfigured}
              testID="security-decoy"
            />
            {visible.decoyConfigured && (
              <SettingsRow
                label={t('settings.security.decoy.remove')}
                leftIcon="lock"
                destructive
                onPress={() => setConfirmRemoveDecoy(true)}
                testID="security-remove-decoy"
              />
            )}
          </SettingsGroup>

          {visible.decoyConfigured && (
            <SettingsGroup label={t('settings.security.wipeCode.sectionTitle')}>
              <View style={styles.stackedRow}>
                <Typography variant="bodySm_regular" style={styles.rowDescription}>
                  {t('settings.security.wipeCode.description')}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.rowDescription}>
                  {t('settings.security.wipeCode.warning')}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.rowDescription}>
                  {t('settings.security.wipeCode.offlineCaveat')}
                </Typography>
              </View>
              <SettingsRow
                label={
                  visible.wipeCodeConfigured
                    ? t('settings.security.wipeCode.configured')
                    : t('settings.security.wipeCode.setUp')
                }
                leftIcon="warning"
                onPress={() => router.push('/settings/pin-setup?kind=wipe')}
                testID="security-wipe-code"
              />
            </SettingsGroup>
          )}
        </>
      )}

      <Modal
        position="center"
        visible={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title={t('settings.security.pin.disableConfirmTitle')}
        description={t('settings.security.pin.disableConfirmMessage')}
        testID="disable-pin-modal"
        actions={[
          {label: t('common.buttons.cancel'), onPress: () => setConfirmDisable(false), variant: 'secondary'},
          {label: t('settings.security.pin.disable'), onPress: handleDisable, variant: 'primary'},
        ]}
      />

      <Modal
        position="center"
        visible={confirmRemoveDecoy}
        onClose={() => setConfirmRemoveDecoy(false)}
        title={t('settings.security.decoy.removeConfirmTitle')}
        description={t('settings.security.decoy.removeConfirmMessage')}
        testID="remove-decoy-modal"
        actions={[
          {label: t('common.buttons.cancel'), onPress: () => setConfirmRemoveDecoy(false), variant: 'secondary'},
          {label: t('settings.security.decoy.remove'), onPress: handleRemoveDecoy, variant: 'primary'},
        ]}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing8,
    gap: spacing.spacing24,
    paddingBottom: spacing.spacing32,
  },

  iconBadge: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  stackedRowDivided: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  stackedRow: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing12,
    paddingBottom: spacing.spacing16,
    gap: spacing.spacing12,
  },
  stackedRowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
  },
  stackedRowBody: {
    flex: 1,
    gap: spacing.spacing4,
  },
  rowLabel: {
    color: colors.textDefault,
  },
  rowDescription: {
    color: colors.textAlternative,
  },
}))
