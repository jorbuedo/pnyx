/**
 * Long-press actions for a message in a direct-message thread.
 *
 * The same shape as {@link MessageActionsSheet} in a circle — `Modal` +
 * `SettingsRow`, the app's one bottom-sheet-of-actions pattern — but over a
 * `DmThreadEntry` rather than a forum `Post`. They are different records: a DM
 * entry has no author id, no reply target and no server route, so forcing one
 * into the other's shape would mean building a `Post` that does not exist.
 *
 * **Delete is local, and how local depends on the thread.** A note to self was
 * never sent anywhere, so removing it is simply a delete. A real conversation has
 * no unsend — MLS gives none, and the peer keeps their copy — so the row says
 * "remove from this device" and means it. The two must not share a word.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useFormatDate} from '../../hooks/useFormatDate'
import {useI18n} from '../../providers'
import {useCopy} from '../../providers/CopyProvider'
import type {DmThreadEntry} from '../../services/dm-session'
import {Modal} from '../Modal'
import {SettingsRow} from '../SettingsRow'
import {Typography} from '../Typography'

export type DmMessageActionsSheetProps = {
  /** The message being acted on; `undefined` closes the sheet. */
  readonly entry: DmThreadEntry | undefined
  /**
   * True for the offline note-to-self thread, where nothing was ever sent and a
   * delete is a delete.
   */
  readonly isNotes: boolean
  readonly onDelete: (entry: DmThreadEntry) => void
  readonly onClose: () => void
}

export const DmMessageActionsSheet = ({entry, isNotes, onDelete, onClose}: DmMessageActionsSheetProps) => {
  const {t} = useI18n()
  const {copy} = useCopy()
  const {formatDateTime} = useFormatDate()

  return (
    <Modal visible={entry !== undefined} onClose={onClose} position="bottom" testID="dm-message-actions">
      {/* Which message this is about. Without it a mis-aimed long press is
          undetectable — the sheet would offer to delete a message the user cannot
          see behind it. */}
      {entry !== undefined && (
        <View style={styles.context}>
          <Typography variant="bodySm_regular" numberOfLines={3}>
            {entry.text ?? t('forum.dm.actions.noText')}
          </Typography>
          <Typography variant="bodyXs_regular" style={styles.time}>
            {formatDateTime(new Date(entry.createdAt), {dateStyle: 'short', timeStyle: 'short'})}
          </Typography>
        </View>
      )}

      {entry?.text !== undefined && entry.text !== '' && (
        <SettingsRow
          label={t('forum.dm.actions.copy')}
          leftIcon="copy"
          onPress={() => {
            void copy({text: entry.text ?? '', feedback: t('forum.dm.actions.copied')})
            onClose()
          }}
          testID="dm-message-copy"
        />
      )}

      <SettingsRow
        label={isNotes ? t('forum.dm.actions.delete') : t('forum.dm.actions.removeHere')}
        description={isNotes ? undefined : t('forum.dm.actions.removeHereBody')}
        leftIcon="delete"
        destructive
        onPress={() => entry !== undefined && onDelete(entry)}
        testID="dm-message-delete"
      />
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  context: {
    gap: spacing.spacing4,
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing12,
  },
  time: {color: colors.textAlternative},
}))
