/**
 * Add Wallet Screen.
 *
 * Single entry point for adding a wallet:
 *
 *  1. Connect a hardware wallet: /wallet/pair-device.
 *  2. New wallet: generate immediately, defer backup.
 *  3. Recovery phrase: /onboarding/restore.
 *  4. Import backup: /onboarding/restore-from-backup.
 *  5. Restore with passkey: /onboarding/restore-with-passkey, shown only when
 *     this device holds a recovery blob (v1: the blob is device-local even
 *     though the passkey itself is cloud-synced).
 *  6. Watch-only address: /onboarding/watch-only.
 *
 * A multisig wallet is deliberately not offered here: it needs an existing wallet
 * to co-sign from, and its own entry point already lives with the shared wallets.
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
import {useI18n, useOnboarding} from '../../src/providers'
import {hasRecoveryBlob, isPasskeyRecoveryAvailable} from '../../src/services/passkey-recovery'

export default function AddWalletScreen() {
  const {t} = useI18n()
  const {setIsQuickStart, setIsAddWallet, reset: resetOnboarding} = useOnboarding()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()
  const createWalletEnabled = useFeatureFlag('createWallet')
  const restoreWalletEnabled = useFeatureFlag('restoreWallet')
  const encryptedBackupEnabled = useFeatureFlag('encryptedBackupExport')

  const {guard, isNavigating, reset: resetGuard} = useGuardedNavigation()

  // Passkey restore only works where the recovery blob lives (v1: this
  // device); hide the tile elsewhere rather than dead-ending the user.
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

  // Entering this screen means we're creating a FUNDS wallet group (identity
  // already exists), not establishing the identity. Mark the flow so
  // preparing.tsx takes the group-creation branch regardless of enclave-probe
  // timing; the flag persists through the deeper method screens and is cleared
  // by reset() at completion.
  useFocusEffect(
    useCallback(() => {
      resetOnboarding()
      setIsAddWallet(true)
    }, [resetOnboarding, setIsAddWallet]),
  )

  const handleQuickStart = () => {
    guard(async () => {
      try {
        logger.info('Quick Start: starting wallet creation', {origin: 'AddWallet'})
        setIsQuickStart(true)
        await navigateToAuthSetup()
      } catch (e) {
        logger.error('Quick Start: failed to start creation', {origin: 'AddWallet', error: String(e)})
        resetGuard()
      }
    })
  }

  const handleRestore = () => {
    guard(() => router.navigate('/onboarding/restore'))
  }

  const handleImportBackup = () => {
    guard(() => router.navigate('/onboarding/restore-from-backup'))
  }

  const handleRestoreWithPasskey = () => {
    guard(() => router.navigate('/onboarding/restore-with-passkey'))
  }

  // Provisional entry point — a hardware wallet's natural home is the Wallets
  // tab (needs its own product mapping). Route is fully reachable meanwhile.
  const handleConnectHardware = () => {
    // Route type isn't inferred across the group yet; narrow cast per CLAUDE.md.
    guard(() => router.navigate('/wallet/pair-device' as never))
  }

  const handleWatchOnly = () => {
    guard(() => router.navigate('/onboarding/watch-only'))
  }

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Typography variant="headingXl" style={styles.title}>
            {t('onboarding.addWallet.title')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t('onboarding.addWallet.subtitle')}
          </Typography>
        </View>

        <View style={styles.tilesContainer}>
          <OnboardingTile
            icon={
              <UniIcon name="tileHardwareWallet" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
            }
            title={t('hardware.tileTitle')}
            subtitle={t('hardware.tileSubtitle')}
            onPress={handleConnectHardware}
            isDisabled={isNavigating}
            testID="add-wallet-connect-hardware"
          />

          {createWalletEnabled && (
            <OnboardingTile
              icon={
                <UniIcon name="tileQuickstart" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
              }
              title={t('onboarding.addWallet.quickstart.title')}
              subtitle={t('onboarding.addWallet.quickstart.subtitle')}
              onPress={handleQuickStart}
              isDisabled={isNavigating}
              testID="add-wallet-quickstart"
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
              title={t('onboarding.addWallet.recovery.title')}
              subtitle={t('onboarding.addWallet.recovery.subtitle')}
              onPress={handleRestore}
              isDisabled={isNavigating}
              testID="add-wallet-recovery"
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
              testID="add-wallet-import-backup"
            />
          )}

          {passkeyRestoreAvailable && (
            <OnboardingTile
              icon={<UniIcon name="tilePasskey" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />}
              title={t('passkeyRecovery.restoreTileTitle')}
              subtitle={t('passkeyRecovery.restoreTileSubtitle')}
              onPress={handleRestoreWithPasskey}
              isDisabled={isNavigating}
              testID="add-wallet-restore-passkey"
            />
          )}

          <OnboardingTile
            icon={<UniIcon name="tileWatchOnly" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />}
            title={t('onboarding.watchOnly.tileTitle')}
            subtitle={t('onboarding.watchOnly.tileSubtitle')}
            onPress={handleWatchOnly}
            isDisabled={isNavigating}
            testID="add-wallet-watch-only"
          />
        </View>
      </ScrollView>
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
