/**
 * Encrypted backup export panel.
 *
 * Two-step inline flow:
 *
 * 1. Password capture — separate "export password" + confirm.
 * 2. Result — QR + copy/share buttons. Tap "Regenerate" to mint a fresh
 *    salt/nonce (useful if the user wants to share a new copy without
 *    invalidating any prior one — there is no on-chain revocation, so
 *    "regenerate" only changes ciphertext, not security posture).
 *
 * State + the primary action live in {@link useEncryptedBackupExport} so
 * the host screen can render the Generate button in a sticky footer
 * (keyboard-aware) instead of inline below the form. The panel itself is
 * presentational.
 *
 * The mnemonic is received as a prop (already decrypted by the parent's
 * auth gate) and lives only in component scope. Nothing about the flow
 * touches storage or routes.
 *
 * @module
 */

import * as Clipboard from 'expo-clipboard'
import {type ReactNode, useCallback, useMemo, useState} from 'react'
import {Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useToast} from '../hooks/useToast'
import {logger} from '../logger'
import {osShowsClipboardToast, platformIsWeb} from '../platform'
import {saveBackupTextFile} from '../platform/backup-file'
import {useI18n} from '../providers'
import {type BackupPayload, buildEncryptedBackup, EncryptedBackupError} from '../utils/encrypted-backup'
import {Button} from './Buttons'
import {QRCard} from './QRCard'
import {TextInput} from './TextInput'
import {Typography} from './Typography'

const MIN_EXPORT_PASSWORD_LENGTH = 8
const QR_SIZE = 240

export type EncryptedBackupExportControls = {
  /** Rendered inside the scrollable content area. */
  readonly content: ReactNode
  /**
   * Primary action for the form step (`Generate`). `null` in the result
   * step — the result's copy/share/regenerate actions render inline with
   * the QR (no keyboard, no need to pin to the bottom).
   */
  readonly footer: ReactNode | null
}

/**
 * Returns the panel content + sticky-footer action for the encrypted
 * backup export flow. The host screen places `content` inside its scroll
 * area and `footer` inside its `<SafeAreaViewWrapper stickyFooter>` slot
 * (or omits when `null`).
 */
export const useEncryptedBackupExport = ({
  payload,
}: {
  /** The secret to export — a `mnemonic` payload (seed wallets) or a `cardano-root` payload (xpriv-only wallets). */
  readonly payload: BackupPayload
}): EncryptedBackupExportControls => {
  const {t} = useI18n()
  const {showToast} = useToast()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [json, setJson] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isPasswordValid = password.length >= MIN_EXPORT_PASSWORD_LENGTH
  const isConfirmValid = confirm === password
  const canGenerate = isPasswordValid && isConfirmValid && !isGenerating

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return
    setIsGenerating(true)
    setError(null)
    try {
      const {link: generated, json: generatedJson} = await buildEncryptedBackup({payload, password})
      setLink(generated)
      setJson(generatedJson)
    } catch (e) {
      logger.error('Encrypted backup generation failed', {origin: 'EncryptedBackupExportPanel', error: String(e)})
      setError(e instanceof EncryptedBackupError ? e.message : 'Could not generate backup. Try again.')
    } finally {
      setIsGenerating(false)
    }
  }, [canGenerate, payload, password])

  const handleCopy = useCallback(async () => {
    if (!link) return
    await Clipboard.setStringAsync(link)
    if (!osShowsClipboardToast) {
      showToast({variant: 'success', message: t('settings.encryptedBackup.export.linkCopied')})
    }
  }, [link, showToast, t])

  const handleShare = useCallback(async () => {
    if (!link) return
    try {
      await Share.share({message: link, title: t('settings.encryptedBackup.export.shareTitle')})
    } catch (e) {
      logger.warn('Share failed', {origin: 'EncryptedBackupExportPanel', cause: e})
    }
  }, [link, t])

  const handleSaveFile = useCallback(async () => {
    if (!json) return
    // Filename only — sanitise the wallet label to a safe basename.
    const base = (payload.label ?? 'wallet').replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'wallet'
    try {
      await saveBackupTextFile({fileName: `${base}.cardanobackup`, text: json})
    } catch (e) {
      logger.warn('Backup file save failed', {origin: 'EncryptedBackupExportPanel', cause: e})
      showToast({variant: 'error', message: t('settings.encryptedBackup.export.saveFailed')})
    }
  }, [json, payload, showToast, t])

  const handleRegenerate = useCallback(() => {
    setLink(null)
    setJson(null)
  }, [])

  const passwordHint = (() => {
    if (!password) return null
    if (!isPasswordValid) return t('settings.encryptedBackup.export.passwordTooShort')
    if (confirm.length > 0 && !isConfirmValid) return t('settings.encryptedBackup.export.passwordsMismatch')
    return null
  })()

  return useMemo<EncryptedBackupExportControls>(() => {
    if (link) {
      return {
        content: (
          <View style={styles.container}>
            <View style={styles.textBlock}>
              <Typography variant="headingSm">{t('settings.encryptedBackup.export.resultTitle')}</Typography>
              <Typography variant="bodyMd_regular" style={styles.subtitle}>
                {t('settings.encryptedBackup.export.resultSubtitle')}
              </Typography>
            </View>

            <View style={styles.qrCard}>
              <QRCard value={link} size={QR_SIZE} testID="encrypted-backup-qr" />
            </View>

            <View style={styles.actions}>
              <Button
                variant="primary"
                leftIcon="copy"
                label={t('settings.encryptedBackup.export.copyLink')}
                onPress={handleCopy}
                size="xl"
                fullWidth
                testID="encrypted-backup-copy-button"
              />
              <Button
                variant="secondary"
                leftIcon="fileText"
                label={t('settings.encryptedBackup.export.saveToFile')}
                onPress={handleSaveFile}
                size="xl"
                fullWidth
                testID="encrypted-backup-save-file-button"
              />
              {!platformIsWeb && (
                <Button
                  variant="secondary"
                  leftIcon="shareOutline"
                  label={t('receive.share')}
                  onPress={handleShare}
                  size="xl"
                  fullWidth
                  testID="encrypted-backup-share-button"
                />
              )}
              <Button
                variant="nakedDefault"
                label={t('settings.encryptedBackup.export.regenerate')}
                onPress={handleRegenerate}
                size="lg"
                fullWidth
                testID="encrypted-backup-regenerate-button"
              />
            </View>
          </View>
        ),
        footer: null,
      }
    }

    return {
      content: (
        <View style={styles.container}>
          <View style={styles.textBlock}>
            <Typography variant="headingSm">{t('settings.encryptedBackup.export.title')}</Typography>
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {t('settings.encryptedBackup.export.subtitle')}
            </Typography>
          </View>

          <View style={styles.fields}>
            <View style={styles.field}>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('settings.encryptedBackup.export.passwordLabel')}
              </Typography>
              <TextInput
                value={password}
                onChange={setPassword}
                secureTextEntry={!showPassword}
                placeholder={t('settings.encryptedBackup.export.passwordPlaceholder')}
                rightIcon={showPassword ? 'eye' : 'hide'}
                onRightIcon={() => setShowPassword((v) => !v)}
                fullWidth
                testID="encrypted-backup-password-input"
              />
            </View>

            <View style={styles.field}>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('settings.encryptedBackup.export.confirmLabel')}
              </Typography>
              <TextInput
                value={confirm}
                onChange={setConfirm}
                secureTextEntry={!showPassword}
                placeholder={t('settings.encryptedBackup.export.confirmPlaceholder')}
                fullWidth
                testID="encrypted-backup-confirm-input"
              />
            </View>

            {passwordHint && (
              <Typography variant="bodyXs_regular" style={styles.errorText}>
                {passwordHint}
              </Typography>
            )}
            {error && (
              <Typography variant="bodyXs_regular" style={styles.errorText}>
                {error}
              </Typography>
            )}
          </View>
        </View>
      ),
      footer: (
        <Button
          label={t('settings.encryptedBackup.export.generateButton')}
          onPress={handleGenerate}
          isDisabled={!canGenerate}
          isLoading={isGenerating}
          fullWidth
          size="xl"
          testID="encrypted-backup-generate-button"
        />
      ),
    }
  }, [
    link,
    password,
    confirm,
    showPassword,
    isGenerating,
    canGenerate,
    error,
    passwordHint,
    handleGenerate,
    handleCopy,
    handleShare,
    handleSaveFile,
    handleRegenerate,
    t,
  ])
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing.spacing20,
  },
  textBlock: {
    gap: theme.spacing.spacing8,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  fields: {
    gap: theme.spacing.spacing12,
  },
  field: {
    gap: theme.spacing.spacing6,
  },
  label: {
    color: theme.colors.textAlternative,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  qrCard: {
    alignItems: 'center',
  },
  actions: {
    gap: theme.spacing.spacing8,
  },
}))
