/**
 * On-device AI settings — the user's opt-in, and the model's provisioning state.
 *
 * Phase 14 item 38. Two independent things decide whether anything AI-shaped appears
 * in the app, and this screen is where both are visible: whether the *device* can run
 * a model, and whether the *user* wants the feature. Capability is not consent, so the
 * toggle defaults to off.
 *
 * ### What is honestly controllable
 *
 * The weights belong to the operating system, not to this app. Android provisions
 * Gemini Nano through AICore and shares it across every app on the device; ML Kit
 * exposes `download()` but no delete, so a "Remove model" button here would not do
 * what it says. Freeing that storage is a system-settings action, and the screen says
 * so rather than offering a control it cannot honour.
 *
 * @module
 */

import {canDownloadModel, downloadModel, type ModelDownloadProgress, onModelDownloadProgress} from '@pnyx/model-native'
import {useCallback, useEffect, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../components/SettingsGroup'
import {SettingsRow} from '../../components/SettingsRow'
import {Toggle} from '../../components/Toggle'
import {Typography} from '../../components/Typography'
import {useModelAvailability} from '../../hooks/useModelAvailability'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {isAiOptedIn, setAiOptedIn} from '../../services/ai-preference'

const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(0)} MB`

export function AiScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {availability, refresh} = useModelAvailability()
  const [optedIn, setOptedIn] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null)

  useEffect(() => {
    let active = true
    void isAiOptedIn().then((v) => {
      if (active) setOptedIn(v)
    })
    return () => {
      active = false
    }
  }, [])

  const toggle = useCallback(async (next: boolean) => {
    setOptedIn(next)
    await setAiOptedIn(next)
  }, [])

  const download = useCallback(async () => {
    setDownloading(true)
    setProgress(null)
    // `totalBytes` arrives only with `started`, so it is merged forward rather than
    // replaced — otherwise the size is lost on the first progress tick.
    const sub = onModelDownloadProgress((p) => setProgress((prev) => ({...prev, ...p})))
    try {
      await downloadModel()
      refresh()
      showToast({variant: 'success', message: t('aiSettings.downloadDone')})
    } catch (e: unknown) {
      logger.warn('On-device model download failed', {origin: 'AiScreen', error: String(e)})
      showToast({variant: 'error', message: t('aiSettings.downloadFailed')})
    } finally {
      sub.remove()
      setDownloading(false)
    }
  }, [refresh, showToast, t])

  const statusLabel = availability === null ? t('aiSettings.status.checking') : t(`aiSettings.status.${availability}`)

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="bodySm_regular" style={styles.muted}>
        {t('aiSettings.intro')}
      </Typography>

      <SettingsGroup label={t('aiSettings.featureLabel')}>
        <SettingsRow
          label={t('aiSettings.optInLabel')}
          description={t('aiSettings.optInDescription')}
          showBorder={false}
          testID="ai-opt-in-row"
        >
          <Toggle checked={optedIn} onChange={(next: boolean) => void toggle(next)} testID="ai-opt-in-switch" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('aiSettings.modelLabel')}>
        <SettingsRow
          label={t('aiSettings.statusLabel')}
          description={statusLabel}
          showBorder={false}
          testID="ai-model-status"
        />
      </SettingsGroup>

      {availability === 'unavailable' ? (
        <Typography variant="bodySm_regular" style={styles.muted}>
          {t('aiSettings.unavailableHelp')}
        </Typography>
      ) : null}

      {/* The OS owns the weights on platforms that provision them themselves, so the
          control appears only where there is something for it to trigger. */}
      {!canDownloadModel && availability === 'downloading' ? (
        <Typography variant="bodySm_regular" style={styles.muted}>
          {t('aiSettings.preparingHelp')}
        </Typography>
      ) : null}

      {canDownloadModel && (availability === 'downloadable' || availability === 'downloading') ? (
        <>
          <Button
            label={downloading ? t('aiSettings.downloading') : t('aiSettings.download')}
            variant="primary"
            size="lg"
            fullWidth
            disabled={downloading}
            onPress={() => void download()}
            testID="ai-download"
          />
          {progress !== null && progress.downloadedBytes !== undefined ? (
            <Typography variant="bodySm_regular" style={styles.muted} testID="ai-download-progress">
              {progress.totalBytes === undefined
                ? megabytes(progress.downloadedBytes)
                : `${megabytes(progress.downloadedBytes)} / ${megabytes(progress.totalBytes)}`}
            </Typography>
          ) : null}
        </>
      ) : null}

      {/* Stated rather than offered as a button: ML Kit exposes no delete, because the
          weights are the operating system's and shared with every other app. */}
      <View style={styles.note}>
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {t('aiSettings.storageNote')}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {t('aiSettings.privacyNote')}
        </Typography>
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    gap: spacing.spacing16,
  },
  muted: {
    color: colors.textMuted,
  },
  note: {
    gap: spacing.spacing8,
  },
}))
