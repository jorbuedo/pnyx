/**
 * Dev-only on-device model probe (Phase 14 item 38).
 *
 * The generation path cannot be exercised on any emulator or simulator — Android
 * needs AICore (flagship hardware only) and iOS needs an Apple-Intelligence-capable
 * device — so this screen exists to answer, on a real device, the two questions the
 * feature is gated on:
 *
 *   - what `getModelStatus()` reports here, including the platform's own `reason`
 *   - whether `generate()` actually returns something usable, and how fast
 *
 * The prompt is fixed and trivial on purpose: this probe tests the *rail*, not the
 * explanation. Prompt quality is `services/explain/prompt.ts`, which is unit-tested.
 *
 * Strings are inline English — dev-only surface, never shipped to users.
 *
 * @module
 */

import {
  downloadModel,
  generate,
  generateStructured,
  getModelStatus,
  type ModelDownloadProgress,
  type ModelSchema,
  type ModelStatus,
  onModelDownloadProgress,
} from '@pnyx/model-native'
import {useCallback, useEffect, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {explainSchema} from '../../../src/services/explain/structured'

const PROBE_PROMPT = 'Reply with exactly the word: ready'

const STRUCTURED_PROBE_PROMPT =
  'The owner received 5.000000 ADA. The network fee was 0.172805 ADA. Explain this transaction.'

/**
 * A shape no build has a class for.
 *
 * Android derives its schema from a compiled Kotlin class, so it can only decode shapes
 * it was built with — and the rejection is the half worth testing, because it is the one
 * that fires on hardware the emulator can reach. The schema check runs before the
 * availability check, so this returns `ERR_MODEL_SCHEMA_UNSUPPORTED` even where there is
 * no model at all, while the real schema returns `ERR_MODEL_UNAVAILABLE`. Two different
 * errors on a device with no AICore is what proves the matcher is wired.
 */
const UNKNOWN_SCHEMA: ModelSchema = {
  type: 'object',
  name: 'NotAShapeAnyBuildHas',
  properties: [{name: 'whatever', schema: {type: 'string'}}],
}

export default function ModelProbeScreen() {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null)

  const readStatus = useCallback(async () => {
    const next = await getModelStatus()
    logger.info('model status', {origin: 'ModelProbe', ...next})
    setStatus(next)
  }, [])

  useEffect(() => {
    void readStatus()
  }, [readStatus])

  const runDownload = useCallback(async () => {
    setDownloading(true)
    setError(null)
    setProgress(null)
    // `totalBytes` only arrives with the `started` phase, so it is merged forward
    // rather than replaced — otherwise the percentage loses its denominator.
    const sub = onModelDownloadProgress((p) => {
      logger.info('model download event', {origin: 'ModelProbe', ...p})
      setProgress((prev) => ({...prev, ...p}))
    })
    try {
      logger.info('model download requested', {origin: 'ModelProbe'})
      await downloadModel()
      logger.info('model download resolved', {origin: 'ModelProbe'})
      const next = await getModelStatus()
      logger.info('model status after download', {origin: 'ModelProbe', ...next})
      setStatus(next)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.warn('model download failed', {origin: 'ModelProbe', error: message})
      setError(message)
    } finally {
      sub.remove()
      setDownloading(false)
    }
  }, [])

  const runGenerate = useCallback(async () => {
    setRunning(true)
    setError(null)
    setOutput(null)
    setElapsedMs(null)
    const started = Date.now()
    try {
      const text = await generate(PROBE_PROMPT)
      logger.info('model generate ok', {origin: 'ModelProbe', chars: text.length})
      setOutput(text)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.warn('model generate failed', {origin: 'ModelProbe', error: message})
      setError(message)
    } finally {
      setElapsedMs(Date.now() - started)
      setRunning(false)
    }
  }, [])

  const runStructured = useCallback(async (schema: ModelSchema, label: string) => {
    setRunning(true)
    setError(null)
    setOutput(null)
    setElapsedMs(null)
    const started = Date.now()
    try {
      const decoded = await generateStructured(STRUCTURED_PROBE_PROMPT, schema)
      logger.info('model generateStructured ok', {origin: 'ModelProbe', label})
      setOutput(JSON.stringify(decoded))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.warn('model generateStructured failed', {origin: 'ModelProbe', label, error: message})
      setError(message)
    } finally {
      setElapsedMs(Date.now() - started)
      setRunning(false)
    }
  }, [])

  return (
    <SafeAreaViewWrapper edges={['bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Typography variant="bodyMd_medium">Availability</Typography>
        <Typography variant="bodySm_regular" testID="model-probe-availability">
          {status === null ? 'reading…' : status.availability}
        </Typography>
        <Typography variant="bodySm_regular" testID="model-probe-reason">
          reason: {status?.reason ?? '(none)'}
        </Typography>
        <Typography variant="bodySm_regular" testID="model-probe-model-name">
          model: {status?.modelName ?? '(not reported)'}
        </Typography>

        <View style={styles.row}>
          <Button label="Re-read status" variant="secondary" size="md" onPress={() => void readStatus()} />
          {status?.availability === 'downloadable' || status?.availability === 'downloading' ? (
            <Button
              label={downloading ? 'Downloading…' : 'Download model'}
              variant="secondary"
              size="md"
              disabled={downloading}
              onPress={() => void runDownload()}
              testID="model-probe-download"
            />
          ) : null}
          <Button
            label={running ? 'Generating…' : 'Run generate()'}
            variant="primary"
            size="md"
            disabled={running}
            onPress={() => void runGenerate()}
            testID="model-probe-generate"
          />
        </View>

        <Typography variant="bodyMd_medium">
          Structured {status?.supportsStructuredOutput === true ? '(supported)' : '(not supported)'}
        </Typography>
        <View style={styles.row}>
          <Button
            label={running ? 'Generating…' : 'Run generateStructured()'}
            variant="primary"
            size="md"
            disabled={running}
            onPress={() => void runStructured(explainSchema(), 'explain')}
            testID="model-probe-structured"
          />
          <Button
            label="…with an unknown schema"
            variant="secondary"
            size="md"
            disabled={running}
            onPress={() => void runStructured(UNKNOWN_SCHEMA, 'unknown-schema')}
            testID="model-probe-structured-unknown"
          />
        </View>

        {progress !== null ? (
          <Typography variant="bodySm_regular" testID="model-probe-progress">
            download: {progress.phase}
            {progress.downloadedBytes === undefined
              ? ''
              : ` ${(progress.downloadedBytes / 1e6).toFixed(1)}MB${
                  progress.totalBytes === undefined ? '' : ` / ${(progress.totalBytes / 1e6).toFixed(1)}MB`
                }`}
          </Typography>
        ) : null}

        {elapsedMs !== null ? <Typography variant="bodySm_regular">elapsed: {elapsedMs}ms</Typography> : null}
        {output !== null ? (
          <Typography variant="bodySm_regular" testID="model-probe-output">
            output: {output}
          </Typography>
        ) : null}
        {error !== null ? (
          <Typography variant="bodySm_regular" testID="model-probe-error">
            error: {error}
          </Typography>
        ) : null}
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  safeArea: {
    flex: 1,
  },
  content: {
    padding: spacing.spacing16,
    gap: spacing.spacing12,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.spacing12,
  },
}))
