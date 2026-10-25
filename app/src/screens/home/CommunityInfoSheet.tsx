/**
 * Community info sheet — opened from the channel panel header. Description,
 * member count, on-chain status, and the caller's membership identity.
 *
 * Invite links (the gate secret as a QR payload) land with the invite-only
 * gate — the share/QR affordance slots in here when they do.
 *
 * ⚠️ **Leaving lives here, and it is irreversible.** `leaveCircle` blanks the
 * caller's leaf in `members`, but nothing releases the join nullifier — so a
 * leaver can never rejoin. The confirm step exists to say that before the tap,
 * not to slow anyone down; see `services/leave-circle-plan.ts` for the two
 * halves and the case that is refused outright.
 *
 * @module
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {ChainBadge} from '../../components/forum/ChainBadge'
import {Modal} from '../../components/Modal'
import {Typography} from '../../components/Typography'
import {useAuthorHandles} from '../../hooks/useAuthorHandles'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {authorLabel} from '../../services/author-label'
import {leavePlan} from '../../services/leave-circle-plan'
import type {Circle, Membership} from '../../services/pnyx-api'
import {pnyxApi} from '../../services/pnyx-api'
import {submitDeviceLeave} from '../../services/pnyx-proving'

export type CommunityInfoSheetProps = {
  readonly circle: Circle | undefined
  readonly membership: Membership | null
  /** The circle's confirmed contract address, or `undefined` while its deploy is unconfirmed. */
  readonly contractAddress?: string | undefined
  readonly visible: boolean
  readonly onClose: () => void
  /** Called after a successful leave, so the rail and the panel drop the circle. */
  readonly onLeft?: (() => void) | undefined
}

export function CommunityInfoSheet({
  circle,
  membership,
  contractAddress,
  visible,
  onClose,
  onLeft,
}: CommunityInfoSheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [confirming, setConfirming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const leave = async () => {
    if (circle === undefined || session === undefined) return
    setLeaving(true)
    setError(undefined)
    const plan = leavePlan({contractAddress, hasForumRoot: session.forumRoot !== undefined})
    try {
      if (plan.kind === 'blocked') {
        logger.warn('a leave was refused rather than half-done', {
          origin: 'CommunityInfoSheet',
          circleId: circle.id,
          reason: plan.reason,
        })
        setError(t('forum.community.leaveBlocked'))
        return
      }
      // The leaf first: it *is* the membership. A row dropped ahead of it would un-list someone who
      // can still prove they belong.
      if (plan.kind === 'chain-then-content' && session.forumRoot !== undefined) {
        await submitDeviceLeave({
          token: session.token,
          forumRoot: session.forumRoot,
          contentCircleId: circle.id,
          chainCircleId: circleIdFromContentId(circle.id),
          circleContractAddress: plan.contractAddress,
        })
      }
      await pnyxApi.leave(session.token, circle.id)
      logger.info('left a circle', {origin: 'CommunityInfoSheet', circleId: circle.id, plan: plan.kind})
      setConfirming(false)
      onLeft?.()
      onClose()
    } catch (e) {
      logger.warn('leaving a circle failed', {origin: 'CommunityInfoSheet', circleId: circle.id, error: String(e)})
      setError(t('forum.community.leaveFailed'))
    } finally {
      setLeaving(false)
    }
  }

  const close = () => {
    // Reset rather than remember: a sheet reopened on the confirm step would be one tap from a
    // permanent action nobody asked for twice.
    setConfirming(false)
    setError(undefined)
    onClose()
  }
  // Gated on `visible`: this sheet stays mounted behind the channel panel, and "member as" is the
  // only line that needs a chain read. A disclosed persona *is* our own id, so this resolves our
  // own name — the same one the ID tab shows.
  const handles = useAuthorHandles(visible && membership !== null ? [membership.persona] : [])
  return (
    <Modal
      visible={visible && circle !== undefined}
      onClose={close}
      position="bottom"
      title={circle?.name ?? t('forum.community.info')}
      testID="community-info-sheet"
    >
      {circle !== undefined && (
        <View style={styles.content}>
          {circle.description.length > 0 && (
            <Typography variant="bodySm_regular" style={styles.description}>
              {circle.description}
            </Typography>
          )}
          <View style={styles.metaLine}>
            <Typography variant="bodyXs_regular" style={styles.meta}>
              {t('forum.home.members', {count: circle.memberCount})}
            </Typography>
            <ChainBadge chain={circle.chain} />
          </View>
          {membership !== null && (
            <View style={styles.metaLine}>
              <Typography variant="bodyXs_regular" style={styles.meta}>
                {t('forum.community.memberAs', {name: authorLabel(membership.persona, handles)})}
              </Typography>
              <ChainBadge chain={membership.chain} />
            </View>
          )}
          {membership !== null &&
            (confirming ? (
              <View style={styles.confirm}>
                <Typography variant="bodySm_medium">
                  {t('forum.community.leaveConfirmTitle', {name: circle.name})}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.warning}>
                  {t('forum.community.leaveConfirmBody')}
                </Typography>
                {error !== undefined && (
                  <Typography variant="bodySm_regular" style={styles.error}>
                    {error}
                  </Typography>
                )}
                <Button
                  label={t('forum.community.leaveConfirmAction')}
                  variant="primary"
                  isError
                  onPress={() => void leave()}
                  isDisabled={leaving}
                  isLoading={leaving}
                  fullWidth
                  testID="community-leave-confirm"
                />
                <Button
                  label={t('forum.community.leaveCancel')}
                  variant="secondary"
                  onPress={() => {
                    setConfirming(false)
                    setError(undefined)
                  }}
                  isDisabled={leaving}
                  fullWidth
                  testID="community-leave-cancel"
                />
              </View>
            ) : (
              <Button
                label={t('forum.community.leave')}
                variant="secondary"
                onPress={() => setConfirming(true)}
                fullWidth
                testID="community-leave"
              />
            ))}
        </View>
      )}
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing.spacing8,
  },
  description: {
    color: theme.colors.textAlternative,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
  meta: {
    color: theme.colors.textMuted,
  },
  confirm: {
    gap: theme.spacing.spacing8,
    paddingTop: theme.spacing.spacing8,
  },
  warning: {
    color: theme.colors.warningDefault,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
