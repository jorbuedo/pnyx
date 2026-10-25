/**
 * What a circle's founder can change about it.
 *
 * Today that is the character the rail draws — the list showed `name[0].toUpperCase()`, so two circles
 * whose names start with the same letter were indistinguishable from each other.
 *
 * ⚠️ **Moderators are not here, and that is not an oversight.** `addModerator` has a native prototype
 * now (`buildAddModeratorProvenTx`), but the sponsor deliberately does not fund it —
 * `SPONSORED_CIRCLE_ENTRY_POINTS` omits the moderator-gated circuits, because paying for a
 * client-supplied one is not something we do. So a promotion has to spend the founder's own DUST, and
 * no rail wires that up. A control for it would be a button that cannot do what it says. Until then a
 * circle's moderator set is exactly its founder, seated by the constructor.
 *
 * @module
 */

import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n, usePnyxSession} from '../../providers'
import {pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {Button} from '../Buttons'
import {Modal} from '../Modal'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'
import {CircleAutoJoinSection} from './CircleAutoJoinSection'
import {CircleInviteSection} from './CircleInviteSection'

export type ManageCircleSheetProps = {
  readonly circleId: string
  /**
   * `false` for an invite-only circle, which is the only kind with invites to manage.
   *
   * `isOpen` is sealed into the contract's initial state and therefore into its address, so it is
   * a property the circle has from birth — never something this sheet could change.
   */
  readonly isOpen: boolean
  /** The circle's contract address once its deploy is confirmed; minting needs it. */
  readonly contractAddress?: string | undefined
  /** What the rail shows now, so the field opens on the current value rather than empty. */
  readonly displayChar?: string | undefined
  readonly visible: boolean
  readonly onClose: () => void
  /** Called after a successful change so the caller can refresh its view. */
  readonly onChanged: () => void
}

export function ManageCircleSheet({
  circleId,
  isOpen,
  contractAddress,
  displayChar,
  visible,
  onClose,
  onChanged,
}: ManageCircleSheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [glyph, setGlyph] = useState(displayChar ?? '')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  const canSubmit = session !== undefined && glyph.trim().length > 0 && !isSubmitting

  const submit = async () => {
    if (!canSubmit || session === undefined) return
    setIsSubmitting(true)
    setError(undefined)
    try {
      // Not trimmed beyond the ends and never normalised: the service decides what one character is,
      // and it counts graphemes so a ZWJ emoji survives.
      await pnyxApi.setCircleDisplayChar(session.token, circleId, {displayChar: glyph.trim()})
      onChanged()
      onClose()
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
      title={t('forum.manage.title')}
      // A gated circle's sheet is taller than the sheet: the rail character, the invite control and
      // the auto-join rule list together run past the bottom, and the permission button below them
      // cannot be reached at all without this. `scrollable` rather than a ScrollView of our own —
      // the modal has to give the scroller a bounded box or it never scrolls (see `Modal.tsx`).
      scrollable
      testID="manage-circle-sheet"
    >
      <View style={styles.content}>
        <Typography variant="bodySm_regular" style={styles.hint}>
          {t('forum.manage.displayCharHint')}
        </Typography>
        <TextInput
          value={glyph}
          onChange={setGlyph}
          placeholder={t('forum.manage.displayCharPlaceholder')}
          fullWidth
          testID="manage-circle-display-char"
        />
        {error !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error}>
            {t(error)}
          </Typography>
        )}
        <Button
          label={t('forum.manage.save')}
          onPress={() => void submit()}
          isDisabled={!canSubmit}
          isLoading={isSubmitting}
          fullWidth
          testID="manage-circle-save"
        />
        {/* Only a gated circle has invites to manage — an open one is joined by anyone. */}
        {!isOpen && (
          <>
            <CircleInviteSection circleId={circleId} contractAddress={contractAddress} />
            {/* Two separate acts, so two separate blocks: minting a code by hand, and letting the
                service mint one for anyone who meets a rule. See CircleAutoJoinSection. */}
            <CircleAutoJoinSection circleId={circleId} contractAddress={contractAddress} />
          </>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing.spacing12,
    paddingBottom: theme.spacing.spacing16,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
