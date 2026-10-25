/**
 * Long-press actions for a chat message (Discord / Telegram shape).
 *
 * The affordances used to sit inline under every message, which put a permanent
 * "Reply" link on every row. Long-press is the convention for this in every chat
 * app, and it keeps the transcript readable.
 *
 * No edit / delete / reactions / pin / forward: the content service exposes
 * `POST /circles/:id/posts` and nothing else, so those rows would be affordances the
 * app cannot honour. Add one here only when its backing route exists.
 *
 * **The identity actions depend on how the author joined.** A disclosed member's
 * persona *is* their `pnyx_id`; a pseudonymous member's subject is never sent to
 * clients. So Copy ID and Message appear only when `authorIdentity` decodes —
 * for a pseudonym there is no id to offer and the rows are absent rather than
 * inert. That does make pseudonymity visible in the menu, which is a deliberate
 * trade: a display name already looks nothing like an id in the transcript.
 *
 * Built on `ScrollableModal` + `SettingsRow`, the same composition as
 * `WalletMoreSheet`, so there is one bottom-sheet-of-actions pattern in the app.
 *
 * @module
 */

import {router} from 'expo-router'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useFormatDate} from '../../hooks/useFormatDate'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {useCopy} from '../../providers/CopyProvider'
import {authorHandle} from '../../services/author-label'
import type {Post} from '../../services/pnyx-api'
import {authorIdentity, formatAuthor} from '../../services/pnyx-forum'
import {Modal} from '../Modal'
import {SettingsRow} from '../SettingsRow'
import {Typography} from '../Typography'
import {AuthorAvatar} from './AuthorAvatar'

export type MessageActionsSheetProps = {
  /** The message being acted on; `undefined` closes the sheet. */
  readonly post: Post | undefined
  /**
   * Handles for the transcript's authors, from the screen that already resolved them. The sheet
   * takes the map rather than looking up its own so the name it shows is the name the message
   * behind it shows — two reads could disagree the moment a claim lands.
   */
  readonly handles: ReadonlyMap<string, string>
  /** Reply is members-only, matching who may post at all. */
  readonly canReply: boolean
  readonly onReply: (post: Post) => void
  readonly onClose: () => void
}

export const MessageActionsSheet = ({post, handles, canReply, onReply, onClose}: MessageActionsSheetProps) => {
  const {t} = useI18n()
  const {copy} = useCopy()
  const {formatDateTime} = useFormatDate()
  // null for a pseudonymous author — see the module doc.
  const pnyxId = post === undefined ? null : authorIdentity(post.author)
  const handle = post === undefined ? undefined : authorHandle(post.author, handles)

  return (
    <Modal visible={post !== undefined} onClose={onClose} position="bottom">
      {/* Which message this is about. Without it a mis-aimed long press is undetectable —
          the sheet would offer to act on a message the user cannot see behind it. Author
          keeps the transcript's accent colour so the two read as the same thing. */}
      {post !== undefined && (
        <View style={styles.context}>
          <AuthorAvatar author={post.author} size={36} />
          <View style={styles.contextText}>
            <View style={styles.contextHeader}>
              <Typography variant="bodySm_medium" numberOfLines={1} style={styles.contextAuthor}>
                {handle ?? formatAuthor(post.author)}
              </Typography>
              <Typography variant="bodyXs_regular" style={styles.contextTime}>
                {formatDateTime(new Date(post.createdAt), {dateStyle: 'short', timeStyle: 'short'})}
              </Typography>
            </View>
            {/* This sheet is where the id lives once a name took its place in the transcript.
                Handles are confusable by construction — the claim policy answers script mixing, not
                lookalikes within one script — so the thing that actually identifies someone has to
                be reachable, and one long press is the shortest honest distance. */}
            {handle !== undefined && (
              <Typography
                variant="bodyXs_regular"
                numberOfLines={1}
                style={styles.contextId}
                testID="message-author-id"
              >
                {formatAuthor(post.author, 20)}
              </Typography>
            )}
            <Typography variant="bodySm_regular" numberOfLines={2} style={styles.contextBody}>
              {post.body}
            </Typography>
          </View>
        </View>
      )}
      {post !== undefined && canReply && (
        <SettingsRow
          label={t('forum.channel.reply')}
          leftIcon="chat"
          onPress={() => {
            onClose()
            onReply(post)
          }}
          testID="message-action-reply"
        />
      )}
      {post !== undefined && (
        <SettingsRow
          label={t('forum.channel.copyText')}
          leftIcon="copy"
          onPress={() => {
            onClose()
            copy({text: post.body}).catch((e) => {
              logger.warn('Failed to copy the message text', {origin: 'MessageActionsSheet', error: String(e)})
            })
          }}
          testID="message-action-copy"
        />
      )}
      {pnyxId !== null && (
        <SettingsRow
          label={t('forum.channel.copyPnyxId')}
          leftIcon="wallet"
          onPress={() => {
            onClose()
            copy({text: pnyxId}).catch((e) => {
              logger.warn('Failed to copy the Pnyx id', {origin: 'MessageActionsSheet', error: String(e)})
            })
          }}
          testID="message-action-copy-id"
        />
      )}
      {pnyxId !== null && (
        <SettingsRow
          label={t('forum.channel.messageAuthor')}
          leftIcon="send"
          onPress={() => {
            onClose()
            // Prefills the id rather than starting the conversation: the user should see
            // who they are about to open a thread with. The start flow reports its own state,
            // including that DM key resolution needs a chain this build may not reach.
            router.push(`/dm/new?peer=${encodeURIComponent(pnyxId)}` as Parameters<typeof router.push>[0])
          }}
          testID="message-action-dm"
        />
      )}
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  context: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing12,
    marginBottom: spacing.spacing4,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  contextText: {
    flex: 1,
    minWidth: 0,
    gap: spacing.spacing4,
  },
  contextHeader: {
    flexDirection: 'row' as const,
    alignItems: 'baseline' as const,
    gap: spacing.spacing8,
  },
  contextAuthor: {
    color: colors.primaryDefault,
    flexShrink: 1,
  },
  contextTime: {
    color: colors.textMuted,
  },
  contextId: {
    color: colors.textMuted,
  },
  contextBody: {
    color: colors.textAlternative,
  },
}))
