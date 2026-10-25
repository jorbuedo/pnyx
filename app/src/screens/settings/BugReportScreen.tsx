/**
 * File a bug report: what happened, optional files, and this session's log trail.
 *
 * ⚠️ **The copy tells the user to file it during the session the bug happened in**, because that
 * is a hard constraint rather than advice. The attached logs are `logger.trail`, an in-memory
 * ring buffer a restart empties — so a report filed the next morning carries the next morning's
 * logs, and the crash it describes is not in them. Saying so on the screen is the difference
 * between a useful report and one that costs a round trip to discover is empty.
 *
 * Every refusal names its own reason. `SubmitFailure` distinguishes "too large", "you are
 * offline", "no identity key" and "the service refused it" because those ask the user for four
 * different things, and one apology for all of them tells them nothing.
 *
 * @module
 */

import * as DocumentPicker from 'expo-document-picker'
import {router} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SettingsRow} from '../../components/SettingsRow'
import {TextArea} from '../../components/TextArea'
import {Typography} from '../../components/Typography'
import {serviceUrl} from '../../config/env'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useConfig, useI18n, usePnyxSession} from '../../providers'
import {readAttachmentContents} from '../../services/bug-report/attachment-contents'
import {cardanoNetworkId} from '../../services/bug-report/network'
import {
  buildReportManifest,
  decideAttachments,
  descriptionIsSubmittable,
  LOG_TRAIL_CAPACITY,
  MAX_ATTACHMENTS,
  MAX_DESCRIPTION_CHARS,
  type ReportAttachment,
  reportContextNow,
} from '../../services/bug-report/report-bundle'
import {submitBugReport} from '../../services/bug-report/submit'

const ORIGIN = 'BugReportScreen'

export const BugReportScreen = () => {
  const {t} = useI18n()
  const {network} = useConfig()
  const {identity} = usePnyxSession()
  const {showToast} = useToast()
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState<readonly ReportAttachment[]>([])
  const [sending, setSending] = useState(false)

  const canSend = useMemo(() => descriptionIsSubmittable(description) && !sending, [description, sending])

  const pick = useCallback(async () => {
    let picked: DocumentPicker.DocumentPickerResult
    try {
      picked = await DocumentPicker.getDocumentAsync({multiple: true, copyToCacheDirectory: true})
    } catch (error) {
      logger.warn('the file picker could not be opened', {origin: ORIGIN, error: String(error)})
      showToast({variant: 'error', message: t('bugReport.pickerFailed')})
      return
    }
    if (picked.canceled) {
      logger.debug('file pick cancelled', {origin: ORIGIN})
      return
    }
    const incoming: readonly ReportAttachment[] = picked.assets.map((asset) => ({
      name: asset.name,
      // Never guessed from the extension — a wrong type on a stored file is worse than none.
      mimeType: asset.mimeType ?? null,
      sizeBytes: asset.size ?? Number.NaN,
      uri: asset.uri,
    }))
    const decision = decideAttachments(attachments, incoming)
    setAttachments(decision.accepted)
    if (decision.rejected.length === 0) return
    // Each refusal logged, one toast shown. A user reporting "it would not take my file" then
    // leaves a trail, even though the screen could only say one thing.
    for (const {attachment, reason} of decision.rejected) {
      logger.info('attachment refused', {origin: ORIGIN, name: attachment.name, reason, size: attachment.sizeBytes})
    }
    const first = decision.rejected[0]
    if (first === undefined) return
    showToast({
      variant: 'neutral',
      message:
        first.reason === 'too-many'
          ? t('bugReport.rejected.tooMany')
          : first.reason === 'single-too-large'
            ? t('bugReport.rejected.singleTooLarge')
            : first.reason === 'unknown-size'
              ? t('bugReport.rejected.unknownSize')
              : t('bugReport.rejected.wouldExceedBudget'),
    })
  }, [attachments, showToast, t])

  const remove = useCallback((uri: string) => {
    setAttachments((current) => current.filter((a) => a.uri !== uri))
  }, [])

  const send = useCallback(async () => {
    setSending(true)
    // Read the attachment bytes before the trail is snapshotted, so a read failure is *in* the
    // logs the report carries rather than in the lines it drops.
    const readAttachments = await readAttachmentContents(attachments)
    const unreadable = readAttachments.filter((a) => a.content === null)
    for (const a of unreadable) {
      logger.warn('attachment could not be read; it ships as an entry with no bytes', {
        origin: ORIGIN,
        name: a.name,
        sizeBytes: a.sizeBytes,
        error: a.readError,
      })
    }
    // Said out loud rather than logged alone: the user picked these files and would otherwise
    // watch a success toast for a report that carries their names and none of their contents.
    if (unreadable.length > 0) {
      showToast({
        variant: 'error',
        message: t('bugReport.attachmentsUnreadable', {count: unreadable.length}),
      })
    }
    // The trail is snapshotted here, before the upload begins. Read afterwards it would contain
    // the upload's own lines and push the thing the user actually did out of a full buffer.
    const manifest = buildReportManifest({
      description,
      // ⚠️ The identity is threaded from the session, not defaulted. Every report from the first
      // device run arrived with `identity: null` because an earlier version defaulted it here and
      // trusted a comment to remind the caller. `null` is still a real answer — a report from a
      // signed-out app is worth having — but it now means signed out rather than not wired up.
      context: reportContextNow({network, identity: identity?.pnyxId ?? null}),
      logs: logger.trail,
      attachments: readAttachments,
      trailCapacity: LOG_TRAIL_CAPACITY,
    })
    const result = await submitBugReport({
      manifest,
      serviceUrl: serviceUrl(),
      networkId: cardanoNetworkId(network),
    })
    setSending(false)
    if (result.ok) {
      // Toast first, then leave. The toast outlives the navigation, so the confirmation is still
      // on screen when Wallets appears — which is what makes leaving safe rather than a screen
      // vanishing with no evidence that anything was sent.
      showToast({variant: 'success', message: t('bugReport.sent')})
      // `dismissTo` rather than `push`: the report screen was pushed over the tabs, and pushing
      // Wallets on top of it would leave the form behind the back gesture with its text still in
      // it, inviting a second copy of the same report.
      router.dismissTo('/(tabs)/wallets')
      return
    }
    const failure = result.failure
    showToast({
      variant: 'error',
      message:
        failure.kind === 'too-large'
          ? t('bugReport.failed.tooLarge')
          : failure.kind === 'no-identity'
            ? t('bugReport.failed.noIdentity')
            : failure.kind === 'offline'
              ? t('bugReport.failed.offline')
              : t('bugReport.failed.refused'),
    })
  }, [attachments, description, identity, network, showToast, t])

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Callout variant="info" message={t('bugReport.intro')} />

      <TextArea
        value={description}
        onChange={setDescription}
        placeholder={t('bugReport.descriptionPlaceholder')}
        maxLength={MAX_DESCRIPTION_CHARS}
        fullWidth
        isDisabled={sending}
        testID="bug-report-description"
      />

      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('bugReport.logsIncluded')}
      </Typography>

      {attachments.length > 0 ? (
        <View style={styles.attachments}>
          {attachments.map((attachment) => (
            <SettingsRow
              key={attachment.uri}
              label={attachment.name}
              description={t('bugReport.attachmentTapToRemove', {
                kb: Math.max(1, Math.round(attachment.sizeBytes / 1024)),
              })}
              leftIcon="fileText"
              iconColor="textMuted"
              onPress={() => remove(attachment.uri)}
              testID={`bug-report-attachment-${attachment.name}`}
              size="lg"
            />
          ))}
        </View>
      ) : null}

      <Button
        variant="secondary"
        label={t('bugReport.addFiles')}
        onPress={() => void pick()}
        isDisabled={attachments.length >= MAX_ATTACHMENTS || sending}
        fullWidth
        testID="bug-report-add-files"
      />

      <Button
        variant="primary"
        label={t('bugReport.send')}
        onPress={() => void send()}
        isDisabled={!canSend}
        isLoading={sending}
        fullWidth
        testID="bug-report-send"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  attachments: {
    gap: theme.spacing.spacing8,
  },
}))
