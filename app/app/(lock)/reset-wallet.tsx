/**
 * Wipe-and-restore recovery screen.
 *
 * There is no app credential to reset — the wallet is protected by the
 * device's own screen lock (enclave scheme). A user who can no longer
 * pass the OS prompt regains access by erasing the local wallet data and
 * restoring from the recovery phrase. This is a security measure — there
 * is no server-side reset.
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {Modal} from '../../src/components/Modal/Modal'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useGuardedNavigation} from '../../src/hooks/useGuardedNavigation'
import {logger} from '../../src/logger'
import {storage} from '../../src/platform/storage'
import {useAuth, useI18n, useWalletList} from '../../src/providers'

export default function ResetWalletScreen() {
  const {t} = useI18n()
  const {guard, isNavigating: isResetting, reset: resetGuard} = useGuardedNavigation()
  const [showConfirm, setShowConfirm] = useState(false)
  const {deleteAllWalletData} = useWalletList()
  const {resetAllAuth} = useAuth()

  const handleReset = useCallback(() => {
    setShowConfirm(false)
    guard(async () => {
      try {
        await deleteAllWalletData()
        await resetAllAuth()

        // Land the user directly on the restore flow — the confirm above
        // was the "I'm returning" signal.
        await storage.set('@pnyx/init_new_or_return_done', 'return')
        router.dismissAll()
        router.replace('/onboarding/restore')
      } catch (e) {
        logger.error('Failed to reset wallets', {origin: 'ResetWalletScreen', error: e})
        resetGuard()
      }
    })
  }, [guard, resetGuard, resetAllAuth, deleteAllWalletData])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.container}>
        <View style={styles.content}>
          <View style={styles.iconWrap}>
            <UniIcon name="warning" width={40} height={40} uniProps={(theme) => ({color: theme.colors.errorDefault})} />
          </View>

          <Typography variant="headingMd" style={styles.title}>
            {t('auth.recoveryReset.title')}
          </Typography>

          <Typography variant="bodyMd_regular" style={styles.description}>
            {t('auth.recoveryReset.description')}
          </Typography>

          <Typography variant="bodyMd_regular" style={styles.description}>
            {t('auth.resetWallets.warning')}
          </Typography>
        </View>

        <View style={styles.buttonContainer}>
          {/* Safe path is the prominent primary; the destructive wipe is a
              de-emphasised naked/error-tinted button so the two don't read
              with identical weight on a wipe-and-restore screen. */}
          <Button
            label={t('common.buttons.goBack')}
            onPress={() => router.back()}
            fullWidth
            size="xl"
            variant="primary"
            isDisabled={isResetting}
            testID="reset-wallet-go-back"
          />
          <Button
            label={t('auth.recoveryReset.resetButton')}
            onPress={() => setShowConfirm(true)}
            fullWidth
            size="xl"
            variant="nakedDefault"
            isError
            isLoading={isResetting}
            testID="reset-wallet-button"
          />
        </View>
      </View>

      <Modal
        position="center"
        visible={showConfirm}
        onClose={() => setShowConfirm(false)}
        title={t('auth.resetWallets.confirmTitle')}
        description={t('auth.resetWallets.confirmMessage')}
        dismissable={!isResetting}
        testID="reset-wallet-confirm-modal"
        actions={[
          {
            label: t('common.buttons.cancel'),
            onPress: () => setShowConfirm(false),
            variant: 'secondary',
            testID: 'reset-wallet-confirm-cancel',
          },
          {
            label: t('auth.resetWallets.resetButton'),
            onPress: handleReset,
            variant: 'primary',
            testID: 'reset-wallet-confirm-reset',
          },
        ]}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  container: {
    flex: 1,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  iconWrap: {
    alignItems: 'center',
  },
  title: {
    textAlign: 'center',
  },
  description: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
  },
  buttonContainer: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing12,
  },
}))
