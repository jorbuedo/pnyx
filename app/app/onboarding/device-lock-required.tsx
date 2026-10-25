/**
 * Blocking explainer: the app requires a device screen lock.
 *
 * Reached from onboarding when the device has no screen-lock credential
 * at all (no biometric AND no passcode). The wallet seed is protected by
 * the OS keychain (`BIOMETRY_ANY_OR_DEVICE_PASSCODE`), so without a
 * device lock there is nothing to gate it — there is deliberately NO
 * bypass. The user sets up a lock in the OS settings and re-checks.
 *
 * @module
 */

import {router, useFocusEffect} from 'expo-router'
import {useCallback, useState} from 'react'
import {Linking, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons/Button'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useI18n} from '../../src/providers'
import {hasDeviceLock} from '../../src/services/keychain-capability'

export default function DeviceLockRequiredScreen() {
  const {t} = useI18n()
  const [isChecking, setIsChecking] = useState(false)

  const recheck = useCallback(async () => {
    setIsChecking(true)
    try {
      if (await hasDeviceLock()) {
        router.replace('/onboarding/secure-with-biometrics')
      }
    } finally {
      setIsChecking(false)
    }
  }, [])

  // Returning from the OS settings re-focuses this screen — re-probe so
  // a freshly configured lock advances the flow without an extra tap.
  useFocusEffect(
    useCallback(() => {
      void recheck()
    }, [recheck]),
  )

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']}>
      <View style={styles.contentContainer}>
        <View style={styles.illustrationContainer}>
          <UniIcon name="lock" width={180} height={180} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
        </View>

        <View style={styles.textContainer}>
          <Typography variant="headingMd" style={styles.title}>
            {t('onboarding.deviceLockRequired.title')}
          </Typography>
          <Typography variant="bodyMd_medium" style={styles.subtitle}>
            {t('onboarding.deviceLockRequired.description')}
          </Typography>
        </View>
      </View>

      <View style={styles.buttonsContainer}>
        <Button
          label={t('onboarding.deviceLockRequired.openSettingsButton')}
          variant="primary"
          size="xl"
          fullWidth
          onPress={() => {
            void Linking.openSettings()
          }}
          testID="device-lock-open-settings-button"
        />
        <Button
          label={t('onboarding.deviceLockRequired.recheckButton')}
          variant="nakedDefault"
          size="xl"
          fullWidth
          onPress={recheck}
          isLoading={isChecking}
          testID="device-lock-recheck-button"
        />
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing32,
  },
  illustrationContainer: {
    alignItems: 'center',
  },
  textContainer: {
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  title: {
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  subtitle: {
    textAlign: 'center',
    color: theme.colors.textAlternative,
  },
  buttonsContainer: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingBottom: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
}))
