/**
 * Backup Verification screen (Settings).
 *
 * Auth-gated flow to view and verify the recovery phrase for wallets
 * that were created via Quick Start (without mnemonic verification).
 *
 * Steps:
 * 1. Enclave retrieve (OS biometric / device-passcode prompt)
 * 2. Show mnemonic
 * 3. Verify mnemonic (word selection)
 * 4. Mark backup as confirmed
 *
 * @module
 */

import {hex as pnyxHex} from '@pnyx/crypto'
import {mnemonicToEntropy} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {LayoutAnimation, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {useEncryptedBackupExport} from '../../src/components/EncryptedBackupExportPanel'
import {CircleLoader} from '../../src/components/Loaders'
import {MnemonicDisplay} from '../../src/components/MnemonicDisplay'
import {SelectedWordsArea, type WordEntry, WordSelectionArea} from '../../src/components/MnemonicVerification'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsRow} from '../../src/components/SettingsRow'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Typography} from '../../src/components/Typography'
import {useFeatureFlag} from '../../src/hooks/useFeatureFlag'
import {useMnemonicBackupStatus} from '../../src/hooks/useMnemonicBackupStatus'
import {logger} from '../../src/logger'
import {useI18n, useWalletList} from '../../src/providers'
import {revealGroupMnemonicForBackup} from '../../src/services/group-seed'
import {retrieveIdentityMnemonic} from '../../src/services/identity-wallet'
import type {BackupPayload} from '../../src/utils/encrypted-backup'

type Step = 'auth' | 'show' | 'verify' | 'loading' | 'export'

const UniCircleLoader = withUnistyles(CircleLoader, (theme) => ({
  color: theme.colors.primaryDefault,
  size: 'lg' as const,
}))

export default function BackupVerificationScreen() {
  const {
    showOnly,
    groupId: routeGroupId,
    identity: identityParam,
  } = useLocalSearchParams<{showOnly?: string; groupId?: string; identity?: string}>()
  // Identity backup reveals the dedicated identity vault slot (pnyx-identity),
  // NOT a wallet group — the forum identity's own recovery phrase.
  const isIdentity = identityParam === 'true'
  const {t} = useI18n()
  const {selectedWalletGroup, walletGroups} = useWalletList()

  const targetGroupId = isIdentity ? undefined : routeGroupId || selectedWalletGroup?.groupId
  const {confirm} = useMnemonicBackupStatus(targetGroupId)
  const encryptedBackupEnabled = useFeatureFlag('encryptedBackupExport')

  const targetWalletName = isIdentity
    ? t('settings.encryptedBackup.restore.defaultWalletName')
    : (walletGroups.find((g) => g.groupId === targetGroupId)?.name ?? '').trim() || 'Wallet'

  const [step, setStep] = useState<Step>('loading')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [decryptError, setDecryptError] = useState<string | null>(null)

  // Retrieve the mnemonic from the enclave vault — the OS biometric /
  // device-passcode prompt fires inside the keychain read. On failure
  // (cancel, invalidated key) the 'auth' step shows the error + retry.
  const decryptAndShow = useCallback(async () => {
    try {
      setDecryptError(null)
      let decrypted: string
      if (isIdentity) {
        decrypted = await retrieveIdentityMnemonic()
      } else if (targetGroupId) {
        decrypted = await revealGroupMnemonicForBackup(targetGroupId)
      } else {
        return
      }
      setMnemonic(decrypted)
      setStep('show')
    } catch (e) {
      logger.error('Failed to decrypt mnemonic for backup verification', {
        origin: 'BackupVerification',
        error: String(e),
      })
      setDecryptError(e instanceof Error ? e.message : 'Failed to decrypt recovery phrase')
      setStep('auth')
    }
  }, [isIdentity, targetGroupId])

  // Fire the enclave retrieve on mount.
  useEffect(() => {
    if (!isIdentity && !targetGroupId) return
    void decryptAndShow()
  }, [isIdentity, targetGroupId, decryptAndShow])

  const handleShowNext = () => {
    setStep('verify')
  }

  // Verification logic
  const expectedOrder = useMemo<WordEntry[]>(
    () =>
      (mnemonic ?? '')
        .split(' ')
        .filter((word) => word.trim().length > 0)
        .map((word, id) => ({word, id})),
    [mnemonic],
  )

  const shuffledEntries = useMemo<WordEntry[]>(
    () => [...expectedOrder].sort((a, b) => a.word.localeCompare(b.word)),
    [expectedOrder],
  )

  const [selectedEntries, setSelectedEntries] = useState<WordEntry[]>([])

  const handleSelectWord = (entry: WordEntry) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setSelectedEntries([...selectedEntries, entry])
  }

  const handleRemoveLast = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setSelectedEntries(selectedEntries.slice(0, -1))
  }

  const handleReplaceLastWord = (entry: WordEntry) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setSelectedEntries([...selectedEntries.slice(0, -1), entry])
  }

  const isComplete = selectedEntries.length === expectedOrder.length
  const isCorrect = isComplete && selectedEntries.every((entry, index) => entry.word === expectedOrder[index]?.word)

  const handleVerifyComplete = async () => {
    // Identity backup is reveal-only (showOnly) and has no group-level backup
    // status to confirm; the group-verify path only runs for funds wallets.
    if (!isIdentity) await confirm()
    router.back()
  }
  if (step === 'loading') {
    return (
      <View style={styles.loadingContainer}>
        <UniCircleLoader />
      </View>
    )
  }

  if (step === 'auth') {
    return (
      <View style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          {decryptError && (
            <Typography variant="bodySm_regular" style={styles.errorText}>
              {decryptError}
            </Typography>
          )}
          <Button
            label={t('common.buttons.tryAgain')}
            onPress={() => {
              setStep('loading')
              void decryptAndShow()
            }}
            size="xl"
            testID="backup-auth-retry-button"
          />
        </View>
      </View>
    )
  }

  if (step === 'show' && mnemonic) {
    return (
      <SafeAreaViewWrapper
        edges={['bottom']}
        stickyFooter={
          <StickyFooter>
            {showOnly ? (
              <Button
                label={t('common.buttons.done')}
                onPress={() => router.back()}
                fullWidth
                size="xl"
                testID="backup-show-done-button"
              />
            ) : (
              <Button
                label={t('common.buttons.next')}
                onPress={handleShowNext}
                fullWidth
                size="xl"
                testID="backup-show-next-button"
              />
            )}
          </StickyFooter>
        }
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.textContainer}>
          <Typography variant="headingSm">{t('settings.backup.title')}</Typography>
          <Typography variant="bodyMd_regular" style={styles.description}>
            {t('settings.backup.subtitle')}
          </Typography>
        </View>

        <MnemonicDisplay mnemonic={mnemonic} />

        {encryptedBackupEnabled && (
          <SettingsRow
            label={t('settings.backup.encryptedExportButton')}
            description={t('settings.backup.encryptedExportSublabel')}
            leftIcon="lock"
            onPress={() => setStep('export')}
            testID="encrypted-backup-entry-row"
          />
        )}
      </SafeAreaViewWrapper>
    )
  }

  if (step === 'export' && mnemonic) {
    // Inner component because `useEncryptedBackupExport` owns React state
    // and must run unconditionally inside whatever component it's used
    // from. Calling the hook from the parent would mean running it on
    // every step, not just the export step.
    return <ExportStep mnemonic={mnemonic} walletName={targetWalletName} />
  }

  if (step === 'verify' && mnemonic) {
    return (
      <SafeAreaViewWrapper
        style={styles.safeArea}
        edges={['bottom']}
        scrollable
        contentContainerStyle={styles.scrollContent}
        stickyFooter={
          <StickyFooter>
            <Button
              label={t('common.buttons.done')}
              onPress={handleVerifyComplete}
              isDisabled={!isComplete || !isCorrect}
              fullWidth
              size="xl"
              testID="backup-verify-done-button"
            />
          </StickyFooter>
        }
      >
        <View style={styles.textContainer}>
          <Typography variant="headingSm">{t('settings.backup.verifyTitle')}</Typography>
          <Typography variant="bodyMd_regular" style={styles.description}>
            {t('settings.backup.verifySubtitle')}
          </Typography>
        </View>

        <SelectedWordsArea
          selectedEntries={selectedEntries}
          expectedOrder={expectedOrder}
          onRemoveLast={handleRemoveLast}
        />

        <View style={styles.selectionHeader}>
          <Typography variant="bodySm_medium" style={styles.selectionLabel}>
            {t('onboarding.verify.selectWord', {number: selectedEntries.length + 1})}
          </Typography>
        </View>

        <WordSelectionArea
          shuffledEntries={shuffledEntries}
          selectedEntries={selectedEntries}
          expectedOrder={expectedOrder}
          onSelectWord={handleSelectWord}
          onReplaceLastWord={handleReplaceLastWord}
        />
      </SafeAreaViewWrapper>
    )
  }

  return null
}

/**
 * Export-step screen. Owns `useEncryptedBackupExport` so the hook only
 * runs while the user is on this step. The form's primary button rides
 * in the sticky footer (keyboard-aware via the wrapper's
 * `KeyboardStickyView`); the result step has no sticky footer — its
 * copy/share/regenerate actions render inline with the QR.
 *
 * The Back button is intentionally not duplicated here — the navigation
 * header already provides one.
 */
function ExportStep({mnemonic, walletName}: {readonly mnemonic: string; readonly walletName: string}) {
  const payload = useMemo<BackupPayload>(
    () => ({
      type: 'mnemonic',
      entropyHex: pnyxHex.encode(mnemonicToEntropy(mnemonic.trim(), wordlist)),
      label: walletName.trim(),
    }),
    [mnemonic, walletName],
  )
  const {content, footer} = useEncryptedBackupExport({payload})
  // No outer KeyboardAvoidingView — `SafeAreaViewWrapper`'s sticky-footer slot
  // is already a `KeyboardStickyView`, and stacking padding-mode KAV on top
  // double-lifts the Generate button off the visible viewport when the
  // password field is focused.
  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      contentContainerStyle={styles.scrollContent}
      scrollable
      stickyFooter={footer != null ? <StickyFooter>{footer}</StickyFooter> : undefined}
    >
      {content}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing.spacing16,
    backgroundColor: theme.colors.backgroundDefault,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  textContainer: {
    gap: theme.spacing.spacing8,
  },
  description: {
    color: theme.colors.textAlternative,
  },
  selectionHeader: {
    paddingTop: theme.spacing.spacing8,
  },
  selectionLabel: {
    color: theme.colors.textAlternative,
    paddingBottom: theme.spacing.spacing8,
  },
  errorText: {
    color: theme.colors.errorDefault,
    textAlign: 'center',
  },
}))
