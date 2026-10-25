/**
 * Bottom sheet for putting a question to the community (a poll).
 *
 * @module
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {submitDeviceProposal} from '../../services/pnyx-proving'
import {Button} from '../Buttons'
import {Modal} from '../Modal'
import {TextArea} from '../TextArea'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'

export type CreatePollSheetProps = {
  readonly circleId: string
  /** The circle's confirmed on-chain id, if any — enables device proving of the proposal. */
  readonly chainCircleId?: string | undefined
  readonly visible: boolean
  readonly onClose: () => void
  /** Called after a successful create so the caller can refresh its view. */
  readonly onCreated: () => void
}

export function CreatePollSheet({circleId, chainCircleId, visible, onClose, onCreated}: CreatePollSheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  const canSubmit = session !== undefined && title.trim().length > 0 && !isSubmitting

  const submit = async () => {
    if (!canSubmit || session === undefined) return
    setIsSubmitting(true)
    setError(undefined)
    const root = session.forumRoot
    // No server-side fallback: the service cannot prove a proposal, only submit one this device proved.
    const useDevice = root !== undefined && chainCircleId !== undefined
    try {
      const {proposal} = await pnyxApi.createProposal(session.token, circleId, {
        title: title.trim(),
        body: details.trim(),
      })
      if (useDevice && root !== undefined && chainCircleId !== undefined) {
        await submitDeviceProposal({
          token: session.token,
          forumRoot: root,
          chainCircleId: circleIdFromContentId(circleId),
          circleContractAddress: chainCircleId,
          contentProposalId: proposal.id,
          // Two, because this sheet creates a yes/no poll. The count is sealed into the contract and
          // into its address, so it is passed explicitly rather than defaulted — a multi-option ballot
          // is a change here, not a change in the rail.
          optionCount: 2,
        })
        logger.info('device-proven proposal submitted', {origin: 'CreatePollSheet', proposalId: proposal.id})
      }
      setTitle('')
      setDetails('')
      onCreated()
    } catch (e) {
      setError(forumErrorKey(e))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('forum.polls.new')}
      testID="create-poll-sheet"
    >
      <View style={styles.content}>
        <TextInput
          value={title}
          onChange={setTitle}
          placeholder={t('forum.polls.titlePlaceholder')}
          fullWidth
          testID="create-poll-title"
        />
        <TextArea
          value={details}
          onChange={setDetails}
          placeholder={t('forum.polls.detailsPlaceholder')}
          fullWidth
          testID="create-poll-details"
        />
        {error !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error}>
            {t(error)}
          </Typography>
        )}
        <Button
          label={t('forum.polls.create')}
          onPress={() => void submit()}
          isDisabled={!canSubmit}
          isLoading={isSubmitting}
          fullWidth
          testID="create-poll-submit"
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing.spacing12,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
