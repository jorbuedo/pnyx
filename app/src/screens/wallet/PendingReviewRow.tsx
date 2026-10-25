/**
 * One inbox row for the pending-review screen, variant by source: a co-sign
 * envelope awaiting more signatures, or a multi-leg signing continuation. Both
 * render through the shared {@link ChainRow} (Cardano) with a status chip and
 * Resume / Dismiss actions; the continuation's Resume is disabled (with a note)
 * when its remaining legs can't be reconstructed.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons/Button'
import {ChainRow} from '../../components/ChainRow'
import {Tag, type TagVariant} from '../../components/Tag'
import {Typography} from '../../components/Typography'
import {useI18n} from '../../providers'
import type {PendingReviewItem} from '../../services/cardano/pending'
import type {AwaitingHere} from '../../services/cardano/pending/awaiting'

/**
 * A ceremony's own name, when its producer declared one. Unlabelled flows keep the generic
 * title — better than a wrong specific one — which is what every row read before producers
 * started passing a context.
 */
const contextTitle = (context: string, t: (key: 'pending.continuation.title') => string): string =>
  context === 'midnight.dustRegistration'
    ? t('pending.continuation.dustRegistration' as 'pending.continuation.title')
    : t('pending.continuation.title')

/** What the chain says about a continuation's legs, when it could be consulted. */
export type ReconciledContinuation = {
  readonly landed: number
  readonly outcome: 'complete' | 'resumable' | 'dead' | 'unknown'
}

export type PendingReviewRowProps = {
  readonly item: PendingReviewItem
  /** Fee + output-count summary; null while loading or undecodable. */
  readonly subtitle: string | null
  /** Chain-reconciled state for a continuation; absent when it could not be checked. */
  readonly reconciled?: ReconciledContinuation
  /**
   * Whose signature this row is waiting on, among the wallets on this device.
   *
   * The list is no longer filtered to the selected wallet — a co-signed transaction belongs
   * to several — so each row has to say which of yours it wants, or the inbox is a pile of
   * transactions with no indication of what to do with any of them.
   */
  readonly awaiting?: AwaitingHere
  readonly onResume: () => void
  readonly onDismiss: () => void
  readonly busy?: boolean
}

export const PendingReviewRow = ({
  item,
  subtitle,
  reconciled,
  awaiting,
  onResume,
  onDismiss,
  busy,
}: PendingReviewRowProps) => {
  const {t} = useI18n()

  /**
   * Only stated when it is known and actionable.
   *
   * `unknown` prints nothing rather than "waiting on others": a multisig roster is not
   * derivable from payment keys, and rendering "not derivable" as "somebody else has it"
   * would be a guess presented as fact.
   */
  const awaitingLabel =
    awaiting?.kind === 'ready'
      ? t('pending.awaitingSubmit')
      : awaiting?.kind === 'you'
        ? t('pending.awaitingYou', {wallets: awaiting.wallets.map((w) => w.name).join(', ')})
        : awaiting?.kind === 'others'
          ? t('pending.awaitingOthers')
          : null

  const title =
    item.kind === 'cosign'
      ? t(`pending.cosign.${item.envelope.kind}` as 'pending.cosign.multisig')
      : contextTitle(item.record.context, t)

  // The reason the record already stores is more use than its status word, so prefer it.
  const rowSubtitle =
    item.kind === 'cosign'
      ? (subtitle ?? undefined)
      : (item.record.error ?? subtitle ?? t(`pending.status.${item.record.status}` as 'pending.status.awaiting-user'))

  // The record's own step count is a belief; the chain's is not.
  const landed = reconciled?.landed ?? (item.kind === 'continuation' ? item.record.currentStepIndex : 0)
  const chipLabel =
    item.kind === 'cosign'
      ? t('pending.quorumChip', {signed: item.status.signed, required: item.status.required})
      : t('pending.stepChip', {current: landed, total: item.record.expectedStepCount})

  const chipVariant: TagVariant =
    item.kind === 'cosign' ? (item.status.meetsQuorum ? 'success' : 'secondary') : 'secondary'

  // Only co-sign resumes, because only co-sign resumes *into a review*. A
  // continuation's stored legs are unsigned, so signing them from here would sign
  // bytes the user was never shown (Phase 16 item 41) — and the chain
  // reconciliation must not be able to re-enable the action, only to refine the
  // note below. A leg whose inputs are spent could never be submitted anyway.
  const canResume = item.kind === 'cosign' ? item.canResume : false
  const note =
    item.kind !== 'continuation'
      ? null
      : reconciled?.outcome === 'dead'
        ? t('pending.continuation.dead')
        : reconciled?.outcome === 'unknown'
          ? t('pending.continuation.unchecked')
          : item.hasUnbroadcastLegs
            ? t('pending.continuation.mustRebuild')
            : t('pending.resumeUnavailable')

  return (
    <ChainRow
      chain={CARDANO_MAINNET}
      name={title}
      {...(rowSubtitle !== undefined ? {subtitle: rowSubtitle} : {})}
      right={<Tag size="sm" label={chipLabel} variant={chipVariant} />}
      testID={`pending-row-${item.id}`}
    >
      {awaitingLabel !== null ? (
        <Typography variant="bodySm_regular" style={styles.note} testID={`pending-awaiting-${item.id}`}>
          {awaitingLabel}
        </Typography>
      ) : null}
      {note !== null ? (
        <Typography variant="bodySm_regular" style={styles.note}>
          {note}
        </Typography>
      ) : null}
      <View style={styles.actions}>
        <Button
          label={t('pending.resume')}
          onPress={onResume}
          isDisabled={busy === true || !canResume}
          size="sm"
          containerStyles={styles.action}
          testID={`pending-resume-${item.id}`}
        />
        <Button
          label={t('pending.dismiss')}
          variant="secondary"
          onPress={onDismiss}
          isDisabled={busy === true}
          size="sm"
          containerStyles={styles.action}
          testID={`pending-dismiss-${item.id}`}
        />
      </View>
    </ChainRow>
  )
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  action: {
    flex: 1,
  },
  note: {
    color: theme.colors.textMuted,
  },
}))
