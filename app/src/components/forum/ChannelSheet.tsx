/**
 * Bottom sheet for adding a channel to a community, or editing one that exists.
 *
 * A channel is **content-layer only** — a grouping label over posts that already exist in the content
 * store, never a contract (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10). So this is one POST and no
 * proving: nothing here touches the chain, and there is no ChainRef to wait for.
 *
 * ⚠️ Only the circle's founder may create or edit one, and the **service** enforces it. The founder is
 * the persona the circle's constructor seated in the on-chain `moderators` tree, so this is that
 * authority checked in the content plane rather than a second one. A moderator promoted later by
 * `addModerator` is refused today — the contract's `moderatorAuth` map is what will let the service
 * authenticate one, and it is not wired here yet.
 *
 * One component for both modes rather than two sheets: the fields, the validation and the error
 * surface are identical, and a second copy is how the two drift.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n, usePnyxSession} from '../../providers'
import {type Channel, pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {Button} from '../Buttons'
import {Modal} from '../Modal'
import {TextArea} from '../TextArea'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'

export type ChannelSheetProps = {
  readonly circleId: string
  readonly visible: boolean
  readonly onClose: () => void
  /**
   * Called after a successful write so the caller can refresh its channel list.
   *
   * ⚠️ Handed the saved channel, not nothing: the channel route's segment **is** the channel's name,
   * so a screen that renamed the channel it is showing has to move to the new name or it renders
   * empty — the route would point at a name no channel has any more.
   */
  readonly onSaved: (channel: Channel) => void
  /**
   * The channel being edited, or omitted to create a new one. Editing is the only mode that can send
   * a cleared description, because there is nothing to clear on a channel that does not exist yet.
   */
  readonly channel?: Channel
}

export function ChannelSheet({circleId, visible, onClose, onSaved, channel}: ChannelSheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const isEdit = channel !== undefined
  const [name, setName] = useState(channel?.name ?? '')
  const [description, setDescription] = useState(channel?.description ?? '')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  // Seeded on open rather than at mount: the sheet stays mounted between openings, so a channel
  // edited after another one would otherwise show the previous channel's name. Keyed on the channel's
  // identity, never on the values it reads — those arrive again on every refresh, and re-seeding from
  // one mid-edit would discard what the user had typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeding is deliberately a snapshot at open
  useEffect(() => {
    if (!visible) return
    setName(channel?.name ?? '')
    setDescription(channel?.description ?? '')
    setError(undefined)
  }, [visible, channel?.id])

  const canSubmit = session !== undefined && name.trim().length > 0 && !isSubmitting

  const submit = async () => {
    if (!canSubmit || session === undefined) return
    setIsSubmitting(true)
    setError(undefined)
    try {
      const trimmed = description.trim()
      const saved =
        channel === undefined
          ? // Omitted rather than sent empty: "no description" and "an empty one" are different, and
            // the panel renders the first as nothing at all.
            await pnyxApi.createChannel(session.token, circleId, {
              name: name.trim(),
              ...(trimmed.length === 0 ? {} : {description: trimmed}),
            })
          : // `null` on an emptied field: a description the user deleted is one they removed, and the
            // service distinguishes that from "leave it alone".
            await pnyxApi.updateChannel(session.token, circleId, channel.id, {
              name: name.trim(),
              description: trimmed.length === 0 ? null : trimmed,
            })
      onSaved(saved.channel)
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
      title={isEdit ? t('forum.channels.edit') : t('forum.channels.new')}
      testID={isEdit ? 'edit-channel-sheet' : 'create-channel-sheet'}
    >
      <View style={styles.content}>
        <TextInput
          value={name}
          onChange={setName}
          placeholder={t('forum.channels.namePlaceholder')}
          fullWidth
          testID="channel-name"
        />
        <TextArea
          value={description}
          onChange={setDescription}
          placeholder={t('forum.channels.descriptionPlaceholder')}
          fullWidth
          testID="channel-description"
        />
        {error !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error}>
            {t(error)}
          </Typography>
        )}
        <Button
          label={isEdit ? t('forum.channels.save') : t('forum.channels.create')}
          onPress={() => void submit()}
          isDisabled={!canSubmit}
          isLoading={isSubmitting}
          fullWidth
          testID="channel-submit"
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
