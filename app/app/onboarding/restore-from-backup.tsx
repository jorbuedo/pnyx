/**
 * Import from encrypted backup (CIP-0301).
 *
 * Serves two entry paths, both converging on the same decrypt step:
 *   - Deep link / QR: a `web+cardano://backup?…` URI arrives as the `link`
 *     param (OS deep link, or handled by the in-app QR scanner). The envelope
 *     is parsed immediately and the screen jumps straight to the password.
 *   - Manual add-wallet: reached from "Import from backup" with no `link`. The
 *     screen offers three ways to supply the envelope — paste the link/JSON,
 *     import a backup file, or scan the QR with the camera — then decrypts.
 *
 * On success it parses the self-describing envelope, asks for the export
 * password, decrypts, and feeds the reconstructed mnemonic into the regular
 * add-wallet flow (`navigateToAuthSetup` → enclave enrollment). Root-key
 * (`cardano-root`) backups are not supported in this Midnight-only shell —
 * only mnemonic payloads restore here.
 *
 * The wallet label lives inside the encrypted payload; after decrypt it is
 * suffix-deduped against existing wallet groups (e.g. "Foo" → "Foo (2)")
 * before being passed downstream as the default name on the auth step.
 *
 * @module
 */

import {hex as pnyxHex} from '@pnyx/crypto'
import {type BackupUri, type CardanoUri, parse as parseUri} from '@pnyx/links'
import {entropyToMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect, Either} from 'effect'
import {useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Modal, TextInput as RNTextInput, ScrollView, View} from 'react-native'
import {KeyboardStickyView} from 'react-native-keyboard-controller'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'

import {Button} from '../../src/components/Buttons'
import {CameraScanner} from '../../src/components/CameraScanner'
import {ChamferBackground} from '../../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {TextInput} from '../../src/components/TextInput'
import {Typography} from '../../src/components/Typography'
import {useOnboardingAuthNavigation} from '../../src/hooks/useOnboardingAuthNavigation'
import {logger} from '../../src/logger'
import {pickBackupTextFile} from '../../src/platform/backup-file'
import {storage} from '../../src/platform/storage'
import {useI18n, useOnboarding, useWalletList} from '../../src/providers'
import {dedupeWalletName} from '../../src/utils/auto-wallet-name'
import {
  decryptEncryptedBackup,
  EncryptedBackupError,
  type EncryptedEnvelope,
  parseEncryptedBackup,
} from '../../src/utils/encrypted-backup'

const hexBytes = (h: string): Uint8Array => Either.getOrThrow(pnyxHex.decode(h))

/** Multiline paste field: placeholder colour must land on a prop, so bind it via Unistyles. */
const PasteInput = withUnistyles(RNTextInput, (theme) => ({
  placeholderTextColor: theme.colors.textMuted,
}))

/**
 * Parse a supplied string into an envelope. Accepts a `web+cardano://backup`
 * link/QR payload or the raw envelope JSON (file / paste). Throws on anything
 * that is neither.
 */
const parseBackupInput = (raw: string): EncryptedEnvelope => {
  const trimmed = raw.trim()
  try {
    const uri = Effect.runSync(parseUri(trimmed as CardanoUri))
    if (uri.authority === 'backup') return parseEncryptedBackup(uri as BackupUri)
  } catch (e: unknown) {
    // Not a parseable URI — fall through and try it as raw envelope JSON. The throw is the
    // probe's answer, so this is debug; it still has to be visible when the JSON attempt also
    // fails and the user is told only that their backup is invalid.
    logger.debug('Backup input is not a parseable URI; trying it as raw envelope JSON', {
      origin: 'restore-from-backup',
      error: String(e),
    })
  }
  return parseEncryptedBackup(trimmed)
}

export default function RestoreFromBackupRoute() {
  const {t} = useI18n()
  const insets = useSafeAreaInsets()
  const {link} = useLocalSearchParams<{link?: string}>()
  const {setMnemonic, setIsRestore, setProposedWalletName} = useOnboarding()
  const {walletGroups} = useWalletList()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()

  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Envelope supplied manually (paste / file / QR) when there's no deep link.
  const [manualEnvelope, setManualEnvelope] = useState<EncryptedEnvelope | null>(null)
  const [manualText, setManualText] = useState('')
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [showScanner, setShowScanner] = useState(false)

  const linkEnvelope = useMemo<EncryptedEnvelope | null>(() => {
    if (!link) return null
    try {
      const uri = Effect.runSync(parseUri(link as CardanoUri))
      if (uri.authority !== 'backup') return null
      return parseEncryptedBackup(uri as BackupUri)
    } catch (e) {
      logger.warn('Invalid encrypted backup link', {origin: 'RestoreFromBackup', error: String(e)})
      return null
    }
  }, [link])

  const envelope = linkEnvelope ?? manualEnvelope
  // Show the source chooser whenever there's no usable envelope yet — including
  // a malformed `link` param (linkEnvelope null) — so a bad deep link falls back
  // to paste / file / QR instead of stranding the user on a disabled password step.
  const showChooser = envelope === null

  // Root-key (xpriv) imports are not supported — the enclave vault stores
  // mnemonics only. Detect from the cleartext payloadType and block up
  // front — fail fast rather than after the user completes auth setup.
  const blockedRootImport = envelope?.payloadType === 'cardano-root'

  // A `link` that's present but unparseable: shown in the chooser (where
  // `showChooser` has routed the user), never in the password step, and cleared
  // once a valid envelope is loaded manually. A live paste/file error wins.
  const linkInvalid = Boolean(link) && !linkEnvelope && !manualEnvelope
  const chooserError = sourceError ?? (linkInvalid ? t('settings.encryptedBackup.restore.invalidLink') : null)

  useEffect(() => {
    // Password-step error only (the root-import block). Invalid-link is surfaced
    // via `chooserError`; decrypt failures are set in `handleRestore`.
    setError(blockedRootImport ? t('settings.encryptedBackup.restore.rootImportUnsupported') : null)
  }, [blockedRootImport, t])

  const loadFromInput = useCallback(
    (raw: string, source: 'manual' | 'file' | 'qr') => {
      try {
        const parsed = parseBackupInput(raw)
        setManualEnvelope(parsed)
        setSourceError(null)
      } catch (e) {
        logger.warn('Invalid backup input', {origin: 'RestoreFromBackup', source, error: String(e)})
        setSourceError(t('settings.encryptedBackup.restore.invalidInput'))
      }
    },
    [t],
  )

  const handlePickFile = useCallback(async () => {
    try {
      const picked = await pickBackupTextFile()
      if (!picked) return
      loadFromInput(picked.text, 'file')
    } catch (e) {
      logger.warn('Backup file read failed', {origin: 'RestoreFromBackup', error: String(e)})
      setSourceError(t('settings.encryptedBackup.restore.fileReadFailed'))
    }
  }, [loadFromInput, t])

  const handleScanned = useCallback(
    (data: string) => {
      setShowScanner(false)
      loadFromInput(data, 'qr')
    },
    [loadFromInput],
  )

  const handleUseDifferent = useCallback(() => {
    setManualEnvelope(null)
    setManualText('')
    setPassword('')
    setError(null)
    setSourceError(null)
  }, [])

  const handleRestore = async () => {
    if (!envelope || blockedRootImport || !password || isDecrypting) return
    setIsDecrypting(true)
    setError(null)
    try {
      const payload = await decryptEncryptedBackup(envelope, password)
      if (payload.type !== 'mnemonic') {
        // Defensive: `blockedRootImport` gates this path already.
        setError(t('settings.encryptedBackup.restore.rootImportUnsupported'))
        return
      }
      const dedupedName = dedupeWalletName(
        payload.label ?? t('settings.encryptedBackup.restore.defaultWalletName'),
        walletGroups.map((g) => g.name),
      )
      setMnemonic(entropyToMnemonic(hexBytes(payload.entropyHex), wordlist))
      setIsRestore(true)
      setProposedWalletName(dedupedName)
      // Brand-new users landing here via deep link bypassed new-or-return.
      // Persist the equivalent intent so the OnboardingInitGuard doesn't
      // bounce them to /onboarding/new-or-return when navigateToAuthSetup
      // pushes to the enclave-enrollment step.
      await storage.set('@pnyx/init_new_or_return_done', 'return')
      await navigateToAuthSetup()
    } catch (e) {
      logger.error('Encrypted backup decryption failed', {origin: 'RestoreFromBackup', error: String(e)})
      // EncryptedBackupError is the password / corrupted-blob path — point the
      // user at the password. Anything else is an internal failure (Argon2id /
      // navigation / etc.) and the password message would be misleading.
      setError(
        e instanceof EncryptedBackupError
          ? t('settings.encryptedBackup.restore.decryptionFailed')
          : t('settings.encryptedBackup.restore.unexpectedError'),
      )
    } finally {
      setIsDecrypting(false)
    }
  }

  const isDisabled = !envelope || blockedRootImport || password.length === 0 || isDecrypting

  // No outer KeyboardAvoidingView: the `KeyboardStickyView` below already
  // lifts the CTA above the keyboard, and stacking padding-mode KAV on top
  // double-lifts it off the visible viewport. The ScrollView with
  // `keyboardShouldPersistTaps="handled"` keeps the inputs reachable.
  return (
    <SafeAreaViewWrapper edges={[]} style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Only the password step needs a heading. On the chooser the nav bar already says
            "Import from backup" and the three affordances below name themselves. */}
        {showChooser ? null : (
          <View style={styles.header}>
            <Typography variant="bodyXs_regular" style={styles.eyebrow}>
              {t('settings.encryptedBackup.restore.eyebrow')}
            </Typography>
            <Typography variant="headingXl" style={styles.title}>
              {t('settings.encryptedBackup.restore.title')}
            </Typography>
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {t('settings.encryptedBackup.restore.subtitle')}
            </Typography>
          </View>
        )}

        {showChooser ? (
          <View style={styles.chooser}>
            <View style={styles.field}>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('settings.encryptedBackup.restore.manualLabel')}
              </Typography>
              <View style={styles.pasteWrap}>
                <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultStrong" />
                <PasteInput
                  style={styles.pasteBox}
                  value={manualText}
                  onChangeText={setManualText}
                  placeholder={t('settings.encryptedBackup.restore.manualPlaceholder')}
                  multiline
                  numberOfLines={5}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textAlignVertical="top"
                  testID="import-backup-manual-input"
                />
              </View>
              <Button
                label={t('settings.encryptedBackup.restore.manualContinue')}
                onPress={() => loadFromInput(manualText, 'manual')}
                isDisabled={manualText.trim().length === 0}
                variant="secondary"
                fullWidth
                testID="import-backup-manual-continue"
              />
            </View>

            <View style={styles.orRow}>
              <View style={styles.orLine} />
              <Typography variant="bodyXs_regular" style={styles.orText}>
                {t('settings.encryptedBackup.restore.orDivider')}
              </Typography>
              <View style={styles.orLine} />
            </View>

            <View style={styles.methodButtons}>
              <Button
                label={t('settings.encryptedBackup.restore.methodFile')}
                onPress={handlePickFile}
                variant="secondary"
                leftIcon="fileText"
                fullWidth
                testID="import-backup-file"
              />
              <Button
                label={t('settings.encryptedBackup.restore.methodScan')}
                onPress={() => setShowScanner(true)}
                variant="secondary"
                leftIcon="qr"
                fullWidth
                testID="import-backup-scan"
              />
            </View>

            {chooserError && (
              <Typography variant="bodySm_regular" style={styles.errorText}>
                {chooserError}
              </Typography>
            )}
          </View>
        ) : (
          <>
            <View style={styles.field}>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('settings.encryptedBackup.restore.passwordLabel')}
              </Typography>
              <TextInput
                value={password}
                onChange={setPassword}
                secureTextEntry={!showPassword}
                placeholder={t('settings.encryptedBackup.restore.passwordPlaceholder')}
                rightIcon={showPassword ? 'eye' : 'hide'}
                onRightIcon={() => setShowPassword((v) => !v)}
                fullWidth
                autoFocus
                testID="encrypted-backup-decrypt-password-input"
              />
            </View>

            {error && (
              <Typography variant="bodySm_regular" style={styles.errorText}>
                {error}
              </Typography>
            )}

            {/* Re-pick is only meaningful once an envelope was supplied manually
                (incl. recovering from a bad deep link); a valid deep link has
                nothing to go back to. */}
            {manualEnvelope && (
              <Button
                label={t('settings.encryptedBackup.restore.useDifferent')}
                onPress={handleUseDifferent}
                variant="nakedDefault"
                testID="import-backup-use-different"
              />
            )}
          </>
        )}
      </ScrollView>

      {!showChooser && (
        <KeyboardStickyView offset={{closed: 0, opened: 20}}>
          <View style={[styles.cta, {paddingBottom: Math.max(insets.bottom, 24)}]}>
            <Button
              label={t('settings.encryptedBackup.restore.decryptButton')}
              onPress={handleRestore}
              isDisabled={isDisabled}
              isLoading={isDecrypting}
              fullWidth
              size="xl"
              testID="encrypted-backup-decrypt-button"
            />
          </View>
        </KeyboardStickyView>
      )}

      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <CameraScanner onScan={handleScanned} onCancel={() => setShowScanner(false)} />
      </Modal>
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
    paddingBottom: theme.spacing.spacing120,
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
  title: {
    color: theme.colors.textDefault,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  chooser: {
    gap: theme.spacing.spacing20,
  },
  field: {
    gap: theme.spacing.spacing6,
  },
  label: {
    color: theme.colors.textAlternative,
  },
  pasteWrap: {minHeight: 120},
  pasteBox: {
    minHeight: 120,
    backgroundColor: 'transparent',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    color: theme.colors.textDefault,
    fontFamily: theme.fontFamily.regular,
    fontSize: theme.fontSizes.bodySm,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.borderDefaultWeak,
  },
  orText: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  methodButtons: {
    gap: theme.spacing.spacing12,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  cta: {
    paddingHorizontal: theme.spacing.spacing20,
    paddingTop: theme.spacing.spacing12,
  },
}))
