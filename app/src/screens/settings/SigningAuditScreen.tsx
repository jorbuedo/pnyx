/**
 * Signing history — every signature this app has produced, newest first.
 *
 * The detection half of Phase 16 item 45: prevention can only fail silently, so an
 * unexplained signature has to be visible here. Row assembly is pure and lives in
 * `signing-audit-rows.ts`. See `docs/SIGNING_AUDIT.md`.
 *
 * @module
 */

import {useCallback, useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Copiable} from '../../components/Copiable'
import {EmptyState} from '../../components/EmptyState'
import {Skeleton} from '../../components/Loaders'
import {Modal} from '../../components/Modal'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../components/SettingsGroup'
import {SettingsRow} from '../../components/SettingsRow'
import {Typography} from '../../components/Typography'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useI18n, useWalletList} from '../../providers'
import {clearSigningAudit, listSigningAudit, type SigningAuditEntry} from '../../services/signing-audit'
import {
  buildSigningAuditRows,
  groupSigningAuditRows,
  type SigningAuditRow,
  summariseFailureReason,
} from './signing-audit-rows'

const ORIGIN = 'SigningAuditScreen'

type LoadState =
  | {readonly status: 'loading'}
  | {readonly status: 'error'}
  | {readonly status: 'ready'; readonly entries: readonly SigningAuditEntry[]}

export function SigningAuditScreen() {
  const {t, formatRelativeTime} = useI18n()
  const {showToast} = useToast()
  const {walletGroups} = useWalletList()
  const [state, setState] = useState<LoadState>({status: 'loading'})
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [showAutomatic, setShowAutomatic] = useState(false)

  const load = useCallback(async () => {
    try {
      setState({status: 'ready', entries: await listSigningAudit()})
    } catch (error) {
      logger.warn('the signing audit could not be read', {origin: ORIGIN, error: String(error)})
      setState({status: 'error'})
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const walletNames = useMemo(
    () => new Map((walletGroups ?? []).map((group) => [group.groupId, group.name])),
    [walletGroups],
  )

  const entries = state.status === 'ready' ? state.entries : []
  const rows = useMemo(() => buildSigningAuditRows(entries, walletNames, Date.now()), [entries, walletNames])
  const {confirmed, automatic} = useMemo(() => groupSigningAuditRows(rows), [rows])

  const actorLabel = (row: SigningAuditRow): string => {
    if (row.actor.kind === 'identity') return t('settings.signingAudit.identityActor')
    const name = row.actor.name ?? t('settings.signingAudit.unknownWallet')
    // An entry that named no account shows the wallet alone rather than claiming account 0. Naming an
    // account the signature never named would be the audit log asserting something untrue.
    if (row.actor.accountIndex === null) return name
    return `${name} · ${t('manageAccounts.accountLabel', {index: row.actor.accountIndex})}`
  }

  /**
   * The subject line. A partially-landed chain says so explicitly rather than
   * reporting the leg count alone — that discrepancy is the whole reason to look here.
   */
  const subjectLabel = (row: SigningAuditRow): string | null => {
    if (row.messageDigests.length > 0 && row.txHashes.length === 0) return t('settings.signingAudit.messageSigned')
    if (row.legCount > row.txHashes.length && row.txHashes.length > 0) {
      return t('settings.signingAudit.partiallyLanded', {landed: row.txHashes.length, total: row.legCount})
    }
    return row.legCount > 1 ? t('settings.signingAudit.legs', {count: row.legCount}) : null
  }

  const describe = (row: SigningAuditRow): string =>
    [
      t(`settings.signingAudit.outcome.${row.outcome}`),
      actorLabel(row),
      row.originHost === null
        ? t('settings.signingAudit.inApp')
        : t('settings.signingAudit.requestedBy', {host: row.originHost}),
      subjectLabel(row),
      formatRelativeTime(row.age.value, row.age.unit),
    ]
      .filter((part): part is string => part !== null)
      .join(' · ')

  /**
   * A row, and — when the signature failed — the reason underneath it.
   *
   * ⚠️ The reason is *not* part of `describe()`. A node rejection is hundreds of characters of JSON,
   * and joined into that line it buried who signed and for which site. It gets its own two lines, and
   * the copy button hands over the whole thing for a bug report.
   */
  const renderRow = (row: SigningAuditRow, index: number, total: number) => {
    const isLast = index === total - 1
    const settingsRow = (
      <SettingsRow
        key={row.id}
        label={t(`settings.signingAudit.purpose.${row.purpose}`)}
        description={describe(row)}
        leftIcon={row.outcome === 'failed' ? 'warning' : 'lock'}
        iconColor={row.outcome === 'failed' ? 'errorDefault' : 'textMuted'}
        size="lg"
        showBorder={row.failureReason === null && !isLast}
        testID={`signing-audit-${row.id}`}
      />
    )
    if (row.failureReason === null) return settingsRow
    return (
      // The divider moves to the wrapper, so it separates this entry from the next one rather than the
      // row from its own reason.
      <View key={row.id} style={styles.entry(!isLast)}>
        {settingsRow}
        <Copiable
          style={styles.reason}
          text={row.failureReason}
          feedback={t('settings.signingAudit.reasonCopied')}
          iconSize={16}
          testID={`signing-audit-reason-${row.id}`}
        >
          <Typography variant="bodyXs_regular" style={styles.reasonText} numberOfLines={2}>
            {summariseFailureReason(row.failureReason)}
          </Typography>
        </Copiable>
      </View>
    )
  }

  const handleClear = async () => {
    setConfirmingClear(false)
    try {
      await clearSigningAudit()
      showToast({variant: 'success', message: t('settings.signingAudit.cleared')})
    } catch (error) {
      logger.warn('the signing audit could not be cleared', {origin: ORIGIN, error: String(error)})
      showToast({variant: 'error', message: t('settings.signingAudit.clearFailed')})
    }
    await load()
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      {state.status === 'loading' ? (
        <View style={styles.skeletonGroup}>
          <Skeleton show height={64} radius={8}>
            {null}
          </Skeleton>
          <Skeleton show height={64} radius={8}>
            {null}
          </Skeleton>
        </View>
      ) : null}

      {state.status === 'error' ? (
        <View style={styles.centered}>
          <EmptyState
            icon="warning"
            title={t('settings.signingAudit.loadFailed')}
            action={{label: t('settings.signingAudit.retry'), onPress: () => void load()}}
            testID="signing-audit-error"
          />
        </View>
      ) : null}

      {state.status === 'ready' && rows.length === 0 ? (
        <View style={styles.centered}>
          <EmptyState
            icon="warning"
            title={t('settings.signingAudit.emptyTitle')}
            description={t('settings.signingAudit.emptyBody')}
            testID="signing-audit-empty"
          />
        </View>
      ) : null}

      {state.status === 'ready' && rows.length > 0 ? (
        <>
          <Typography variant="bodySm_regular" style={styles.introText}>
            {t('settings.signingAudit.intro')}
          </Typography>

          {/* Empty groups do not render — an empty "You confirmed these" is not a section. */}
          {confirmed.length > 0 ? (
            <>
              <SettingsGroup label={t('settings.signingAudit.confirmedLabel')}>
                {confirmed.map((row, index) => renderRow(row, index, confirmed.length))}
              </SettingsGroup>
              <Typography variant="bodySm_regular" style={styles.anomalyText}>
                {t('settings.signingAudit.anomalyNote')}
              </Typography>
            </>
          ) : null}

          {/*
            Collapsed by default. These are a few per launch, so left expanded they bury the
            confirmed section under near-identical rows — the same "signal lost in noise"
            failure as counting them alarmingly. Nothing is hidden from the record: the
            count is always stated and the rows are one tap away.
          */}
          {automatic.length > 0 ? (
            <>
              <Button
                label={
                  showAutomatic
                    ? t('settings.signingAudit.automaticHide')
                    : t('settings.signingAudit.automaticShow', {count: automatic.length})
                }
                variant="secondary"
                size="lg"
                fullWidth
                onPress={() => setShowAutomatic((v) => !v)}
                testID="signing-audit-toggle-automatic"
              />
              {showAutomatic ? (
                <>
                  <SettingsGroup label={t('settings.signingAudit.automaticLabel')}>
                    {automatic.map((row, index) => renderRow(row, index, automatic.length))}
                  </SettingsGroup>
                  <Typography variant="bodySm_regular" style={styles.introText}>
                    {t('settings.signingAudit.automaticExplainer')}
                  </Typography>
                </>
              ) : null}
            </>
          ) : null}

          <Button
            label={t('settings.signingAudit.clear')}
            variant="secondary"
            size="lg"
            fullWidth
            onPress={() => setConfirmingClear(true)}
            testID="signing-audit-clear"
          />
        </>
      ) : null}

      <Modal
        position="center"
        visible={confirmingClear}
        onClose={() => setConfirmingClear(false)}
        title={t('settings.signingAudit.clearTitle')}
        description={t('settings.signingAudit.clearBody')}
        actions={[
          {label: t('settings.signingAudit.cancel'), variant: 'secondary', onPress: () => setConfirmingClear(false)},
          {label: t('settings.signingAudit.clear'), isError: true, onPress: () => void handleClear()},
        ]}
        testID="signing-audit-clear-confirm"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    gap: spacing.spacing16,
  },
  skeletonGroup: {
    gap: spacing.spacing12,
  },
  centered: {
    paddingTop: spacing.spacing32,
  },
  introText: {
    color: colors.textMuted,
  },
  anomalyText: {
    color: colors.textMuted,
  },
  entry: (withBorder: boolean) => ({
    borderBottomWidth: withBorder ? 1 : 0,
    borderBottomColor: colors.borderDefaultWeak,
  }),
  reason: {
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing12,
    alignItems: 'flex-start',
  },
  reasonText: {
    color: colors.errorDefault,
  },
}))
