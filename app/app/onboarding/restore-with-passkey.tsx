/**
 * Restore with passkey (onboarding import path).
 *
 * Counterpart of the enrollment screen: assert the enrolled passkey (OS
 * biometric prompt), let its PRF output unwrap the stored recovery blob
 * (synced or local mirror), and feed the recovered mnemonic into the regular restore flow
 * (`navigateToAuthSetup` → enclave enrollment) — same convergence point as
 * manual phrase entry and encrypted-backup import.
 *
 * Cross-device (see src/services/passkey-recovery.ts): the recovery blob is
 * read from the user's synced store (iCloud Keychain / Google Block Store), so
 * a fresh device that has the provider-synced passkey can restore here. When no
 * blob is found (cloud sync off, or never enrolled) it explains why and points
 * at the other restore paths.
 *
 * @module
 */

import {PasskeyError} from '@pnyx/passkey-native'
import {useCallback, useEffect, useState} from 'react'
import {View} from 'react-native'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {useOnboardingAuthNavigation} from '../../src/hooks/useOnboardingAuthNavigation'
import {logger} from '../../src/logger'
import {useI18n, useOnboarding, useWalletList} from '../../src/providers'
import {hasRecoveryBlob, PasskeyRecoveryError, restoreMnemonicWithPasskey} from '../../src/services/passkey-recovery'
import {dedupeWalletName} from '../../src/utils/auto-wallet-name'

type ScreenState = 'checking' | 'ready' | 'no-blob' | 'restoring'

const restoreErrorKey = (e: unknown) => {
  if (e instanceof PasskeyRecoveryError) {
    if (e.code === 'no-blob') return 'passkeyRecovery.restore.noBlobDescription' as const
    return 'passkeyRecovery.restore.errorDecryptFailed' as const
  }
  if (e instanceof PasskeyError) {
    if (e.code === 'cancelled') return 'passkeyRecovery.restore.errorCancelled' as const
    if (e.code === 'no-credential') return 'passkeyRecovery.restore.errorNoCredential' as const
    if (e.code === 'unsupported') return 'passkeyRecovery.unsupported' as const
  }
  return 'passkeyRecovery.restore.errorGeneric' as const
}

export default function RestoreWithPasskeyScreen() {
  const {t} = useI18n()
  const insets = useSafeAreaInsets()
  const {setMnemonic, setIsRestore, setProposedWalletName, setRecoveredBirthdays} = useOnboarding()
  const {walletGroups} = useWalletList()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()

  const [state, setState] = useState<ScreenState>('checking')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const present = await hasRecoveryBlob()
      if (!cancelled) setState(present ? 'ready' : 'no-blob')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleRestore = useCallback(async () => {
    if (state === 'restoring') return
    setError(null)
    setState('restoring')
    try {
      const {mnemonic, accountName, birthdays} = await restoreMnemonicWithPasskey()
      setMnemonic(mnemonic)
      setIsRestore(true)
      // ⚠️ After `setMnemonic`, which clears them: it resets the flow for a newly assigned seed.
      setRecoveredBirthdays(birthdays ?? null)
      setProposedWalletName(
        dedupeWalletName(
          accountName,
          walletGroups.map((g) => g.name),
        ),
      )
      await navigateToAuthSetup()
      // Stay in 'restoring' while this screen unmounts behind the push.
    } catch (e) {
      logger.error('Passkey restore failed', {origin: 'RestoreWithPasskey', error: String(e)})
      setError(t(restoreErrorKey(e)))
      setState(e instanceof PasskeyRecoveryError && e.code === 'no-blob' ? 'no-blob' : 'ready')
    }
  }, [
    state,
    setMnemonic,
    setIsRestore,
    setRecoveredBirthdays,
    setProposedWalletName,
    walletGroups,
    navigateToAuthSetup,
    t,
  ])

  return (
    <SafeAreaViewWrapper edges={[]} style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Typography variant="bodyXs_regular" style={styles.eyebrow}>
            {t('passkeyRecovery.restore.eyebrow')}
          </Typography>
          <Typography variant="headingXl">
            {t(state === 'no-blob' ? 'passkeyRecovery.restore.noBlobTitle' : 'passkeyRecovery.restore.title')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t(state === 'no-blob' ? 'passkeyRecovery.restore.noBlobDescription' : 'passkeyRecovery.restore.subtitle')}
          </Typography>
        </View>

        {error !== null && state !== 'no-blob' && (
          <Typography variant="bodySm_regular" style={styles.errorText} testID="restore-passkey-error">
            {error}
          </Typography>
        )}
      </View>

      {state !== 'no-blob' && (
        <View style={[styles.cta, {paddingBottom: Math.max(insets.bottom, 24)}]}>
          <Button
            label={t('passkeyRecovery.restore.restoreButton')}
            onPress={handleRestore}
            isDisabled={state === 'checking'}
            isLoading={state === 'restoring'}
            fullWidth
            size="xl"
            testID="restore-passkey-button"
          />
        </View>
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.spacing20,
    gap: theme.spacing.spacing24,
  },
  header: {
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
  eyebrow: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  cta: {
    paddingHorizontal: theme.spacing.spacing20,
    paddingTop: theme.spacing.spacing12,
  },
}))
