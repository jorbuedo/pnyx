/**
 * App lock screen — enclave-native unlock.
 *
 * There is no app-level password or PIN: unlocking the app fires the OS
 * authentication sheet which prefers the enrolled biometric and falls back
 * to the device passcode. Callers inject the unlock action via `unlock`;
 * the app passes the enclave sign-in ceremony (see `useEnclaveUnlock`) so
 * the single OS prompt both unlocks and signs in. When no `unlock` is given
 * the screen falls back to a bare `expo-local-authentication` check, which
 * mirrors the seed's own credential scheme (the enclave vault stores
 * mnemonics under `BIOMETRY_ANY_OR_DEVICE_PASSCODE`).
 *
 * Users who lost the ability to unlock (e.g. wiped device credentials)
 * recover by restoring from their recovery phrase via `onRecovery`.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {BackHandler, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../components/Buttons'
import {Typography} from '../components/Typography'
import {UniIcon} from '../components/UniIcon'
import {useLatestRef} from '../hooks/useLatestRef'
import {logger} from '../logger'
import {useI18n} from '../providers'
import {deviceAuth} from '../services/credential-vault/device-auth'

type Props = {
  /** Called when the OS biometric / device-passcode prompt succeeds. */
  onSuccess: () => void
  /** Called when "Can't unlock?" is pressed — routes to wipe-and-restore. */
  onRecovery: () => void
  /**
   * The unlock action; resolves `true` when the user is authenticated.
   * Defaults to a bare `expo-local-authentication` check. The app injects
   * the enclave sign-in ceremony (`useEnclaveUnlock`) so the one prompt
   * both unlocks and signs in.
   */
  unlock?: () => Promise<boolean>
  /** Swallow Android hardware back so user can't dismiss the lock screen. */
  blockHardwareBack?: boolean
  /** Logger origin tag for auth-error diagnostics. */
  origin: string
}

// Device-credential fallback stays ENABLED: on devices without a usable
// biometric the OS sheet asks for the screen-lock PIN / pattern / passcode
// directly — that's the device's credential, not an app password.
const bareDeviceAuth = deviceAuth

export function BiometricFirstLockScreen({onSuccess, onRecovery, unlock, blockHardwareBack = false, origin}: Props) {
  const {t} = useI18n()
  const [isAuthenticating, setIsAuthenticating] = useState(false)

  const handleUnlock = useCallback(async () => {
    setIsAuthenticating(true)
    try {
      const succeeded = await (unlock ?? bareDeviceAuth)()
      if (succeeded) {
        onSuccess()
      }
    } catch (err) {
      logger.warn('device auth unavailable', {origin, err: String(err)})
    } finally {
      setIsAuthenticating(false)
    }
  }, [onSuccess, unlock, origin])

  const handleUnlockRef = useLatestRef(handleUnlock)

  // Fire the OS prompt once on mount (latest handler read via ref). The
  // Unlock button below re-triggers after a cancel / failure.
  useEffect(() => {
    handleUnlockRef.current()
  }, [])

  useEffect(() => {
    if (!blockHardwareBack) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => subscription.remove()
  }, [blockHardwareBack])

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <View style={styles.iconBadge}>
          <UniIcon name="faceID" size="xl" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
        </View>
        <Typography variant="headingMd" style={styles.title}>
          {t('auth.lockScreen.title')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.subtitle}>
          {t('auth.lockScreen.subtitle')}
        </Typography>
      </View>
      <View style={styles.footer}>
        <Button
          label={t('auth.lockScreen.unlockButton')}
          onPress={handleUnlock}
          isLoading={isAuthenticating}
          fullWidth
          size="xl"
          testID="lock-unlock-button"
        />
        <Button
          label={t('auth.lockScreen.recoveryLink')}
          onPress={onRecovery}
          variant="nakedDefault"
          fullWidth
          size="xl"
          testID="lock-recovery-link"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
  iconBadge: {
    width: 88,
    height: 88,
    borderRadius: theme.borderRadius.roundedCircle,
    backgroundColor: `${theme.colors.primaryDefault}1A`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.spacing16,
  },
  title: {
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  subtitle: {
    textAlign: 'center',
    color: theme.colors.textAlternative,
  },
  footer: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingBottom: rt.insets.bottom + theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
}))
