/**
 * Passkey recovery enrollment screen (Settings, reached from the profile).
 *
 * Wraps the IDENTITY wallet's seed under a WebAuthn PRF-derived key
 * (see src/services/passkey-recovery.ts): the enclave vault releases the
 * seed (OS biometric prompt), then the platform passkey prompt creates
 * the credential and evaluates PRF. States: unsupported platform, not yet
 * enrolled (intro + honest sync caveat), enrolled (re-create / remove),
 * plus busy and error.
 *
 * @module
 */

import {PasskeyError} from '@pnyx/passkey-native'
import {useCallback, useEffect, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {Modal} from '../../src/components/Modal'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession} from '../../src/providers'
import {
  enrollPasskeyRecovery,
  getRecoveryBlob,
  isPasskeyRecoveryAvailable,
  removePasskeyRecovery,
} from '../../src/services/passkey-recovery'

type EnrollmentState =
  | {step: 'loading'}
  | {step: 'unsupported'}
  | {step: 'idle'}
  | {step: 'busy'}
  | {step: 'enrolled'; accountName: string; justEnrolled: boolean}

const enrollErrorKey = (e: unknown) => {
  if (e instanceof PasskeyError) {
    if (e.code === 'cancelled') return 'passkeyRecovery.errorCancelled' as const
    if (e.code === 'prf-unsupported') return 'passkeyRecovery.errorPrfUnsupported' as const
    if (e.code === 'unsupported') return 'passkeyRecovery.unsupported' as const
  }
  return 'passkeyRecovery.errorGeneric' as const
}

export default function PasskeyRecoveryScreen() {
  const {t} = useI18n()
  const {decryptIdentityMnemonic, identityEstablished} = usePnyxSession()

  const [state, setState] = useState<EnrollmentState>({step: 'loading'})
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isPasskeyRecoveryAvailable()) {
        if (!cancelled) setState({step: 'unsupported'})
        return
      }
      const blob = await getRecoveryBlob()
      if (cancelled) return
      setState(blob === null ? {step: 'idle'} : {step: 'enrolled', accountName: blob.accountName, justEnrolled: false})
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleEnroll = useCallback(async () => {
    if (state.step === 'busy') return
    setError(null)
    setState({step: 'busy'})
    try {
      const accountName = t('settings.encryptedBackup.restore.defaultWalletName')
      // The recovery blob wraps the IDENTITY seed (identity/wallet split) —
      // funds wallets have their own per-wallet backup paths. Enclave prompt
      // first (release the seed), passkey prompt second.
      const mnemonic = await decryptIdentityMnemonic()
      await enrollPasskeyRecovery({mnemonic, accountName})
      setState({step: 'enrolled', accountName, justEnrolled: true})
    } catch (e) {
      logger.error('Passkey recovery enrollment failed', {origin: 'PasskeyRecovery', error: String(e)})
      setError(t(enrollErrorKey(e)))
      const blob = await getRecoveryBlob()
      setState(blob === null ? {step: 'idle'} : {step: 'enrolled', accountName: blob.accountName, justEnrolled: false})
    }
  }, [state.step, decryptIdentityMnemonic, t])

  const handleRemove = useCallback(async () => {
    setConfirmRemove(false)
    try {
      await removePasskeyRecovery()
      setError(null)
      setState({step: 'idle'})
    } catch (e) {
      logger.error('Passkey recovery removal failed', {origin: 'PasskeyRecovery', error: String(e)})
      setError(t('passkeyRecovery.errorGeneric'))
    }
  }, [t])

  if (state.step === 'loading') {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <View />
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      {state.step === 'unsupported' ? (
        <Typography variant="bodyMd_regular" style={styles.muted} testID="passkey-recovery-unsupported">
          {t('passkeyRecovery.unsupported')}
        </Typography>
      ) : (
        <>
          {state.step === 'enrolled' ? (
            <View style={styles.section}>
              {state.justEnrolled && (
                <Typography variant="bodyMd_medium" style={styles.success} testID="passkey-recovery-success">
                  {t('passkeyRecovery.successMessage')}
                </Typography>
              )}
              <Typography variant="headingSm">{t('passkeyRecovery.enrolledTitle')}</Typography>
              <Typography variant="bodyMd_regular" style={styles.muted}>
                {t('passkeyRecovery.enrolledDescription', {accountName: state.accountName})}
              </Typography>
            </View>
          ) : (
            <View style={styles.section}>
              <Typography variant="bodyMd_regular" style={styles.muted}>
                {t('passkeyRecovery.intro')}
              </Typography>
            </View>
          )}

          <Typography variant="bodySm_regular" style={styles.caveat}>
            {t('passkeyRecovery.syncCaveat')}
          </Typography>

          {error !== null && (
            <Typography variant="bodySm_regular" style={styles.errorText} testID="passkey-recovery-error">
              {error}
            </Typography>
          )}

          <View style={styles.actions}>
            <Button
              label={t(state.step === 'enrolled' ? 'passkeyRecovery.reEnrollButton' : 'passkeyRecovery.enrollButton')}
              onPress={handleEnroll}
              isLoading={state.step === 'busy'}
              isDisabled={identityEstablished !== true}
              fullWidth
              size="xl"
              testID="passkey-recovery-enroll-button"
            />
            {state.step === 'enrolled' && (
              <Button
                label={t('passkeyRecovery.removeButton')}
                onPress={() => setConfirmRemove(true)}
                variant="nakedDefault"
                fullWidth
                testID="passkey-recovery-remove-button"
              />
            )}
          </View>
        </>
      )}

      <Modal
        position="center"
        visible={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={t('passkeyRecovery.removeConfirmTitle')}
        testID="passkey-recovery-remove-modal"
      >
        <View style={styles.modalContent}>
          <Typography variant="bodyMd_regular" style={styles.muted}>
            {t('passkeyRecovery.removeConfirmMessage')}
          </Typography>
          <Button
            label={t('passkeyRecovery.removeConfirmButton')}
            onPress={handleRemove}
            fullWidth
            testID="passkey-recovery-remove-confirm"
          />
          <Button
            label={t('common.buttons.cancel')}
            onPress={() => setConfirmRemove(false)}
            variant="secondary"
            fullWidth
            testID="passkey-recovery-remove-cancel"
          />
        </View>
      </Modal>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  section: {
    gap: theme.spacing.spacing8,
  },
  muted: {
    color: theme.colors.textAlternative,
  },
  caveat: {
    color: theme.colors.textMuted,
  },
  success: {
    color: theme.colors.successDefault,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  actions: {
    gap: theme.spacing.spacing8,
    paddingTop: theme.spacing.spacing8,
  },
  modalContent: {
    gap: theme.spacing.spacing12,
  },
}))
