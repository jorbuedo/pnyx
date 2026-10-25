/**
 * Choose Setup Type Screen — "Welcome back" / import picker.
 *
 * Reached when the user taps "Import" on the entry screen, or when adding a
 * new account from an existing session.
 *
 * - "Welcome back" title + subtitle.
 * - Create new wallet (existing users only) / Recovery phrase / Import backup.
 *
 * @module
 */

import {router, useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {OnboardingTile} from '../../src/components/OnboardingTile'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useFeatureFlag} from '../../src/hooks/useFeatureFlag'
import {useGuardedNavigation} from '../../src/hooks/useGuardedNavigation'
import {useOnboardingAuthNavigation} from '../../src/hooks/useOnboardingAuthNavigation'
import {logger} from '../../src/logger'
import {useI18n, useOnboarding, useWalletList} from '../../src/providers'
import {hasRecoveryBlob, isPasskeyRecoveryAvailable} from '../../src/services/passkey-recovery'

/**
 * Choose setup type screen for wallet onboarding.
 */
export default function ChooseSetupTypeScreen() {
  const {t} = useI18n()
  const {wallets} = useWalletList()
  const {setIsQuickStart, reset: resetOnboarding} = useOnboarding()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()
  const createWalletEnabled = useFeatureFlag('createWallet')
  const restoreWalletEnabled = useFeatureFlag('restoreWallet')
  const encryptedBackupEnabled = useFeatureFlag('encryptedBackupExport')

  const {guard, isNavigating, reset: resetGuard} = useGuardedNavigation()

  useFocusEffect(
    useCallback(() => {
      resetOnboarding()
    }, [resetOnboarding]),
  )

  // Show "Create Wallet" only when user already has wallets (adding another).
  // First-time users use Quick Start on the new-user screen instead.
  const showCreateWallet = createWalletEnabled && wallets.length > 0

  const handleCreate = () => {
    guard(async () => {
      setIsQuickStart(true)
      try {
        await navigateToAuthSetup()
      } catch (e) {
        logger.error('Failed to navigate to auth setup', {origin: 'ChooseSetupType', error: String(e)})
        resetGuard()
      }
    })
  }

  /**
   * ⚠️ **This is the screen a new phone lands on**, so the passkey tile matters more here than on
   * `add-wallet`, where it already appeared. `getRecoveryBlob` reads the synced store first
   * precisely to cover a fresh device; the blob is not device-local, whatever `add-wallet`'s stale
   * comment says. Gated on the blob existing so a user without one is not dead-ended.
   */
  const [passkeyRestoreAvailable, setPasskeyRestoreAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const available = isPasskeyRecoveryAvailable() && (await hasRecoveryBlob())
      if (!cancelled) setPasskeyRestoreAvailable(available)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleRestoreWithPasskey = () => {
    guard(() => router.navigate('/onboarding/restore-with-passkey'))
  }

  const handleRestore = () => {
    guard(() => router.navigate('/onboarding/restore'))
  }

  const handleImportBackup = () => {
    guard(() => router.navigate('/onboarding/restore-from-backup'))
  }

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Typography variant="headingXl" style={styles.title}>
            {t('onboarding.existingMethod.title')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t('onboarding.existingMethod.subtitle')}
          </Typography>
        </View>

        <View style={styles.tilesContainer}>
          {/* First and badged when there is something to restore from: it is the only route here that
              needs neither a written-down phrase nor a file, so where it works it is the one to
              reach for. Absent entirely otherwise — see the gate above. */}
          {passkeyRestoreAvailable && (
            <OnboardingTile
              icon={<UniIcon name="tilePasskey" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />}
              title={t('passkeyRecovery.restoreTileTitle')}
              subtitle={t('passkeyRecovery.restoreTileSubtitle')}
              badge={t('passkeyRecovery.restoreTileBadge')}
              recommended
              onPress={handleRestoreWithPasskey}
              isDisabled={isNavigating}
              testID="setup-restore-passkey-button"
            />
          )}

          {showCreateWallet && (
            <OnboardingTile
              icon={
                <UniIcon name="tileCreateWallet" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
              }
              title={t('onboarding.existingMethod.create.title')}
              subtitle={t('onboarding.existingMethod.create.subtitle')}
              onPress={handleCreate}
              isDisabled={isNavigating}
              testID="setup-create-new-wallet-button"
            />
          )}

          {restoreWalletEnabled && (
            <OnboardingTile
              icon={
                <UniIcon
                  name="tileRecoveryPhrase"
                  size="sm"
                  uniProps={(theme) => ({color: theme.colors.textDefault})}
                />
              }
              title={t('onboarding.existingMethod.recovery.title')}
              subtitle={t('onboarding.existingMethod.recovery.subtitle')}
              onPress={handleRestore}
              isDisabled={isNavigating}
              testID="setup-restore-wallet-button"
            />
          )}

          {encryptedBackupEnabled && (
            <OnboardingTile
              icon={
                <UniIcon name="tileImportBackup" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
              }
              title={t('onboarding.addWallet.importBackup.title')}
              subtitle={t('onboarding.addWallet.importBackup.subtitle')}
              onPress={handleImportBackup}
              isDisabled={isNavigating}
              testID="setup-import-backup-button"
            />
          )}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing20,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing24,
  },
  header: {
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
  title: {
    color: theme.colors.textDefault,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  tilesContainer: {
    gap: theme.spacing.spacing8,
  },
}))
