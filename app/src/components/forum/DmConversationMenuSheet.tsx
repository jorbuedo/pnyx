/**
 * The ⋮ menu for a direct-message thread.
 *
 * Same shape as the browser's `BrowserMenuSheet` — the shared `Modal` in `position="bottom"` with
 * `SettingsRow`s — rather than a copy of it: that sheet is all page navigation and injection
 * toggles, so what the two genuinely share is the primitives, and forking it would have carried
 * browser concepts into a conversation.
 *
 * Deliberately a presentational component: it renders what it is given and reports presses. The
 * thread owns the state and the confirmation, so the destructive action can be worded against what
 * is actually about to be lost.
 *
 * @module
 */

import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import {Modal} from '../Modal'
import {SettingsRow} from '../SettingsRow'

export type DmConversationMenuSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  /** Wipe the locally stored plaintext. Absent for a thread with nothing stored. */
  readonly onClear?: (() => void) | undefined
  readonly clearing?: boolean | undefined
  /**
   * Toggle notifications for this conversation. Absent for the notes thread, which has no peer.
   *
   * ⚠️ The label is about *notifications*, never about receiving: muting does not un-accept anyone,
   * and copy that implied it would leave people wondering where their messages went.
   */
  readonly onToggleMute?: (() => void) | undefined
  readonly muted?: boolean | undefined
  readonly muting?: boolean | undefined
  /** Refuse everything from this person from now on. Absent for the notes thread. */
  readonly onBlock?: (() => void) | undefined
  readonly blocking?: boolean | undefined
  /**
   * Remove the conversation from this device entirely — the group session included, which is what
   * separates it from {@link DmConversationMenuSheetProps.onClear}. Absent for the notes thread,
   * which has no group to end.
   */
  readonly onDelete?: (() => void) | undefined
  readonly deleting?: boolean | undefined
}

export const DmConversationMenuSheet = ({
  visible,
  onClose,
  onClear,
  clearing,
  onToggleMute,
  muted,
  muting,
  onBlock,
  blocking,
  onDelete,
  deleting,
}: DmConversationMenuSheetProps) => {
  const {t} = useI18n()
  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('forum.dm.menu.title')}
      showDragIndicator
      contentContainerStyle={styles.content}
      testID="dm-menu-sheet"
    >
      {onToggleMute !== undefined && (
        <SettingsRow
          label={muted === true ? t('forum.dm.menu.unmute') : t('forum.dm.menu.mute')}
          description={muted === true ? t('forum.dm.menu.unmuteDescription') : t('forum.dm.menu.muteDescription')}
          onPress={muting === true ? undefined : onToggleMute}
          testID="dm-menu-mute"
        />
      )}
      {onClear !== undefined && (
        <SettingsRow
          label={t('forum.dm.menu.clear')}
          description={t('forum.dm.menu.clearDescription')}
          onPress={clearing === true ? undefined : onClear}
          testID="dm-menu-clear"
        />
      )}
      {onBlock !== undefined && (
        <SettingsRow
          label={t('forum.dm.menu.block')}
          description={t('forum.dm.menu.blockDescription')}
          onPress={blocking === true ? undefined : onBlock}
          testID="dm-menu-block"
        />
      )}
      {/* Last, and the only destructive-styled row: everything above is recoverable, this is not. */}
      {onDelete !== undefined && (
        <SettingsRow
          label={t('forum.dm.menu.delete')}
          description={t('forum.dm.menu.deleteDescription')}
          destructive
          onPress={deleting === true ? undefined : onDelete}
          testID="dm-menu-delete"
        />
      )}
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
}))
