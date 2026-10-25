/**
 * Bottom sheet for joining a community with an "appear as" choice: wallet
 * identity, or a display name that exists only in that community.
 *
 * @module
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {decodeCircleInvite} from '@pnyx/contract-client/circle-invite'
import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {submitDeviceJoin} from '../../services/pnyx-proving'
import {Button} from '../Buttons'
import {Modal} from '../Modal'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'
import {CircleInviteRequestSection} from './CircleInviteRequestSection'
import {type DisplayNameChoice, DisplayNamePicker, isChoiceValid, personaFromChoice} from './DisplayNamePicker'

export type JoinCommunitySheetProps = {
  /**
   * The community to join; the sheet is hidden while undefined.
   *
   * `isOpen` decides whether an invite is asked for *and* which transcript the join builds, so it is
   * not merely a label — a gated circle joined without one is refused by the contract.
   */
  readonly circle: {readonly id: string; readonly name: string; readonly isOpen: boolean} | undefined
  /** The circle's confirmed on-chain id (the sequential counter), if any — enables device proving. */
  readonly chainCircleId?: string | undefined
  readonly onClose: () => void
  /** Called after a successful join so the caller can refresh its view. */
  readonly onJoined: () => void
}

export function JoinCommunitySheet({circle, chainCircleId, onClose, onJoined}: JoinCommunitySheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [choice, setChoice] = useState<DisplayNameChoice>({mode: 'wallet', name: ''})
  const [invite, setInvite] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)
  // A gated circle cannot be joined without a decodable invite, so the button says so by staying
  // disabled rather than failing after the tap.
  const needsInvite = circle !== undefined && !circle.isOpen
  /**
   * The typed code, decoded — `undefined` until it is a whole, checksummed invite.
   *
   * Decoded here rather than at submit so the button reflects it, and logged rather than swallowed:
   * a half-typed code is an expected absence (hence `debug`), but "the paste was malformed" and "the
   * field is still empty" are different facts and only one of them is worth a user's attention.
   */
  const inviteSecret = useMemo(() => {
    if (!needsInvite || invite.trim().length === 0) return undefined
    try {
      return decodeCircleInvite(invite)
    } catch (e) {
      logger.debug('invite code does not decode yet', {origin: 'JoinCommunitySheet', error: String(e)})
      return undefined
    }
  }, [needsInvite, invite])
  const canSubmit =
    session !== undefined &&
    circle !== undefined &&
    isChoiceValid(choice) &&
    (!needsInvite || inviteSecret !== undefined) &&
    !isSubmitting

  const submit = async () => {
    if (!canSubmit || session === undefined || circle === undefined) return
    setIsSubmitting(true)
    setError(undefined)
    // On-device proving iff the flag is on, we have the anonymous-identity master, and the circle is
    // already confirmed on-chain (we need its contract address — each circle is its own contract).
    const forumRootBytes = session.forumRoot
    // There is no server-side fallback any more — the service cannot prove a join, only balance and
    // submit one this device proved. Without a `forumRoot` or a confirmed circle address the join
    // lands in the content plane and its ChainRef stays absent, which is what the badge already shows.
    const useDevice = forumRootBytes !== undefined && chainCircleId !== undefined
    try {
      await pnyxApi.join(session.token, circle.id, personaFromChoice(choice))
      if (useDevice && forumRootBytes !== undefined && chainCircleId !== undefined) {
        await submitDeviceJoin({
          token: session.token,
          forumRoot: forumRootBytes,
          contentCircleId: circle.id,
          chainCircleId: circleIdFromContentId(circle.id),
          circleContractAddress: chainCircleId,
          ...(inviteSecret === undefined ? {} : {inviteSecret}),
        })
        logger.info('device-proven join submitted', {origin: 'JoinCommunitySheet', circleId: circle.id})
      }
      setChoice({mode: 'wallet', name: ''})
      setInvite('')
      onJoined()
    } catch (e) {
      setError(forumErrorKey(e))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      visible={circle !== undefined}
      onClose={onClose}
      position="bottom"
      // The invite field, the community's requirements and the wallet list together outrun a phone
      // screen, and an unscrolled sheet clips its own Join button off the bottom.
      scrollable
      title={circle === undefined ? '' : t('forum.join.title', {name: circle.name})}
      testID="join-community-sheet"
    >
      <View style={styles.content}>
        {needsInvite && (
          <>
            <TextInput
              value={invite}
              onChange={setInvite}
              placeholder={t('forum.join.invitePlaceholder')}
              autoCapitalize="none"
              fullWidth
              testID="join-community-invite"
            />
            {/* The requirements and the wallet choice live together, because the choice depends on
                them — see CircleInviteRequestSection. A granted code lands in the field above rather
                than joining outright: the person still picks how they appear, and a code they hold
                is worth seeing and worth keeping if they close the sheet. */}
            {circle !== undefined && (
              <CircleInviteRequestSection circleId={circle.id} onGranted={(granted) => setInvite(granted)} />
            )}
          </>
        )}
        <DisplayNamePicker
          choice={choice}
          onChange={setChoice}
          identity={session?.identity}
          testID="join-community-display-name"
        />
        {error !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error}>
            {t(error)}
          </Typography>
        )}
        <Button
          label={t('forum.join.submit')}
          onPress={() => void submit()}
          isDisabled={!canSubmit}
          isLoading={isSubmitting}
          fullWidth
          testID="join-community-submit"
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
