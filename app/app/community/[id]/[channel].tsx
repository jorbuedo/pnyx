/**
 * Chat view — the community's discussion as a Discord-style channel, pushed
 * full screen.
 *
 * The route segment is the channel's **name**. A name that matches one of the circle's channels
 * renders that channel's posts and files new ones into it; `general` with no such channel is the
 * circle's **default stream** — the posts carrying no `channelId`, which is where everything written
 * before channels existed lives. A name matching neither renders empty rather than silently showing
 * another channel's transcript.
 *
 * Messages render chronologically; a reply shows a reference line to its
 * direct parent above the message (one reference level — the data model's
 * arbitrary-depth tree is unchanged). Members post/reply through the sticky
 * composer; authors render as their per-community display name.
 *
 * Per-message actions live behind a **long press** (`MessageActionsSheet`), not an
 * inline link under every row — the Discord / Telegram convention, and it keeps the
 * transcript readable.
 */

import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {FlatList, Pressable, RefreshControl, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ButtonIcon} from '../../../src/components/Buttons'
import {EmptyState} from '../../../src/components/EmptyState'
import {AuthorAvatar} from '../../../src/components/forum/AuthorAvatar'
import {ChannelSheet} from '../../../src/components/forum/ChannelSheet'
import {MessageActionsSheet} from '../../../src/components/forum/MessageActionsSheet'
import {LinkActionCard} from '../../../src/components/LinkActionCard'
import {MessageComposer} from '../../../src/components/MessageComposer'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {UniIcon} from '../../../src/components/UniIcon'
import {useAuthorHandles} from '../../../src/hooks/useAuthorHandles'
import {useCommunityView} from '../../../src/hooks/useCommunityView'
import {useFormatDate} from '../../../src/hooks/useFormatDate'
import {useStickToBottom} from '../../../src/hooks/useStickToBottom'
import {logger} from '../../../src/logger'
import {useI18n, usePnyxSession} from '../../../src/providers'
import {LinkActionSheet, type LinkActionSubject} from '../../../src/screens/cardano/LinkActionSheet'
import {authorLabel} from '../../../src/services/author-label'
import {clearComposerDraft, readComposerDraft} from '../../../src/services/composer-draft'
import {readLinkAction} from '../../../src/services/link-action'
import {type Post, pnyxApi} from '../../../src/services/pnyx-api'
import {buildChatTimeline, type ChatMessage} from '../../../src/services/pnyx-forum'
import {linkActionSubjectFor} from '../../../src/utils/link-action-subject'

/** Avatar gutter. Shared with the reply reference's indent, which has to clear it. */
const AVATAR_SIZE = 32

type MessageProps = {
  readonly message: ChatMessage
  readonly onLongPress: (post: Post) => void
  /** Our own `pnyx_id`, so an action link we posted reads as a record. */
  readonly selfIdentity: string | undefined
  /** Handles for the whole transcript's authors; an absent one renders as the id. */
  readonly handles: ReadonlyMap<string, string>
  /** Scroll the transcript to the message a reply references. */
  readonly onJumpTo: (postId: string) => void
  /** Open the details sheet for a link action in this channel. */
  readonly onOpenRequest: (subject: LinkActionSubject, raw: string, mine: boolean) => void
}

function Message({message, onLongPress, selfIdentity, handles, onJumpTo, onOpenRequest}: MessageProps) {
  const {t} = useI18n()
  const {formatDateTime} = useFormatDate()
  const {post, replyTo} = message
  const action = readLinkAction(post.body)
  const subject = action === null ? null : linkActionSubjectFor(action, 'link')
  const mine = post.author === selfIdentity
  return (
    <Pressable
      onLongPress={() => onLongPress(post)}
      delayLongPress={300}
      style={styles.message}
      // Long-press is invisible to a screen reader on its own, so the hint is what
      // makes the actions reachable rather than merely present.
      accessibilityRole="button"
      accessibilityLabel={`${authorLabel(post.author, handles)}: ${post.body}`}
      accessibilityHint={t('forum.channel.messageActionsHint')}
      testID={`post-${post.id}`}
    >
      {/* Above the avatar row, not inside the text column: the avatar belongs beside the name of
          whoever is speaking, and nesting the reference pushed the name down so the avatar lined up
          with the quoted author instead. Tapping it goes to the message being answered. */}
      {replyTo !== undefined && (
        <Pressable
          onPress={() => onJumpTo(replyTo.id)}
          style={styles.replyReference}
          accessibilityRole="button"
          accessibilityLabel={t('forum.channel.jumpToReply')}
          testID={`post-${post.id}-reference`}
        >
          <View style={styles.replySpine} />
          <Typography variant="bodyXs_medium" numberOfLines={1} style={styles.replyReferenceAuthor}>
            {authorLabel(replyTo.author, handles)}
          </Typography>
          <Typography variant="bodyXs_regular" numberOfLines={1} style={styles.replyReferenceBody}>
            {replyTo.body}
          </Typography>
        </Pressable>
      )}
      <View style={styles.messageRow}>
        <AuthorAvatar author={post.author} size={AVATAR_SIZE} />
        <View style={styles.messageColumn}>
          <View style={styles.messageHeader}>
            <Typography variant="bodySm_medium" numberOfLines={1} style={styles.messageAuthor}>
              {authorLabel(post.author, handles)}
            </Typography>
            <Typography variant="bodyXs_regular" style={styles.messageTime}>
              {formatDateTime(new Date(post.createdAt), {dateStyle: 'short', timeStyle: 'short'})}
            </Typography>
          </View>
          {/* A `pnyx://` action link in a circle means what it means in a DM, so it
              gets the same card and the same rule: it describes, and tapping opens
              the real flow. Everything else is an ordinary post. A circle is more
              public than a thread, which makes the "never acts" property matter
              more here, not less. */}
          {action === null ? (
            <Typography variant="bodyMd_regular">{post.body}</Typography>
          ) : (
            <LinkActionCard
              action={action}
              mine={mine}
              onOpenDetails={subject === null ? undefined : () => onOpenRequest(subject, post.body, mine)}
              onOpenUrl={(url) => router.push({pathname: '/browser', params: {url}})}
              // Route type isn't inferred for the tx group; narrow cast per CLAUDE.md.
              onOpenTransaction={(hash) => router.push(`/wallet/tx/${hash}` as never)}
            />
          )}
        </View>
      </View>
    </Pressable>
  )
}

export default function ChannelScreen() {
  const {id, channel, draft} = useLocalSearchParams<{id: string; channel: string; draft?: string}>()
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {view, isLoading, refresh} = useCommunityView(id)
  // Seeded into the initial state, not through an effect: a body handed to this screen to send is the
  // composer's starting value, and writing it later would overwrite whatever the user had typed. The
  // same registry the DM thread reads — see `services/composer-draft`.
  const [body, setBody] = useState(() => readComposerDraft(draft) ?? '')
  const [replyTo, setReplyTo] = useState<Post | undefined>(undefined)
  const [actionsFor, setActionsFor] = useState<Post | undefined>(undefined)
  /**
   * The request whose details sheet is open, or `null`. A sheet rather than a
   * screen: the card says what the request is, and everything else belongs one tap
   * deeper rather than crowding a channel.
   */
  const [openRequest, setOpenRequest] = useState<{subject: LinkActionSubject; raw: string; mine: boolean} | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [editVisible, setEditVisible] = useState(false)

  const member = view?.membership ?? null
  /**
   * Which channel this screen is, resolved from the route segment by name.
   *
   * `undefined` with `isDefaultStream` true means the circle's own stream; `undefined` with it false
   * means the name matches nothing, and the timeline is then deliberately empty.
   */
  const activeChannel = useMemo(() => (view?.channels ?? []).find((c) => c.name === channel), [view?.channels, channel])
  const isDefaultStream = activeChannel === undefined && (channel === undefined || channel === 'general')
  const visiblePosts = useMemo(() => {
    const posts = view?.posts ?? []
    if (activeChannel !== undefined) return posts.filter((p) => p.channelId === activeChannel.id)
    // ⚠️ The default stream is `channelId` **absent**, not "any post" — filtering on truthiness would
    // pull every channel's transcript into #general.
    if (isDefaultStream) return posts.filter((p) => p.channelId === undefined)
    return []
  }, [view?.posts, activeChannel, isDefaultStream])
  const timeline = useMemo(() => buildChatTimeline(visiblePosts), [visiblePosts])
  /**
   * Whether to offer renaming this channel.
   *
   * Same founder rule the channel list uses for "new channel" — the service is the real gate, and this
   * only decides whether to show an affordance that would work. **The default stream is excluded on
   * purpose:** it is the absence of a channel row, so there is nothing to rename.
   */
  const canEditChannel =
    activeChannel !== undefined &&
    view !== undefined &&
    view.membership !== null &&
    view.membership.persona === view.circle.author
  // A name is how you are seen here; the id is what the long-press sheet keeps. Resolved for the
  // whole transcript at once — a reply reference names an author the timeline may not itself draw.
  const handles = useAuthorHandles(
    timeline.flatMap(({post, replyTo}) => (replyTo === undefined ? [post.author] : [post.author, replyTo.author])),
  )
  // A channel opens on the last thing said, not the first.
  const stick = useStickToBottom<FlatList<(typeof timeline)[number]>>()
  const channelName = channel ?? t('forum.community.general')

  const indexOfPost = useMemo(() => new Map(timeline.map((m, i) => [m.post.id, i])), [timeline])

  // A parent is always in the same timeline — `buildChatTimeline` only sets `replyTo` from a post it
  // also emits — so a miss here means the list changed under the tap, and doing nothing is right.
  const jumpToPost = useCallback(
    (postId: string) => {
      const index = indexOfPost.get(postId)
      if (index === undefined) return
      stick.ref.current?.scrollToIndex({index, animated: true, viewPosition: 0.5})
    },
    [indexOfPost, stick.ref],
  )

  const renderMessage = useCallback(
    ({item}: {item: ChatMessage}) => (
      <Message
        message={item}
        onLongPress={setActionsFor}
        selfIdentity={session?.identity}
        handles={handles}
        onJumpTo={jumpToPost}
        onOpenRequest={(subject, raw, mine) => setOpenRequest({subject, raw, mine})}
      />
    ),
    [session?.identity, handles, jumpToPost],
  )

  const send = () => {
    if (session === undefined || id === undefined || body.trim().length === 0 || isSending) return
    setIsSending(true)
    pnyxApi
      .createPost(session.token, id, {
        body: body.trim(),
        ...(replyTo === undefined ? {} : {parentId: replyTo.id}),
        // Omitted on the default stream, so the post lands where this screen is already reading.
        ...(activeChannel === undefined ? {} : {channelId: activeChannel.id}),
      })
      .then(() => {
        setBody('')
        setReplyTo(undefined)
        clearComposerDraft()
        refresh()
      })
      .catch((e) => {
        logger.warn('Send failed; refreshing the channel', {origin: 'ChannelScreen', error: String(e)})
        refresh()
      })
      .finally(() => setIsSending(false))
  }

  const composer =
    member !== null ? (
      <MessageComposer
        value={body}
        onChangeText={setBody}
        onSend={send}
        placeholder={t('forum.channel.composerPlaceholder', {channel: channelName})}
        sendLabel={t('forum.channel.send')}
        isSending={isSending}
        above={
          replyTo !== undefined ? (
            <View style={styles.replyBar}>
              <Typography variant="bodyXs_regular" style={styles.replyBarText} numberOfLines={1}>
                {t('forum.channel.replyingTo', {name: authorLabel(replyTo.author, handles)})}
              </Typography>
              <ButtonIcon
                icon="close"
                size="xs"
                onPress={() => setReplyTo(undefined)}
                containerProps={{accessibilityLabel: t('forum.channel.cancelReply')}}
                testID="composer-cancel-reply"
              />
            </View>
          ) : undefined
        }
      />
    ) : view !== undefined ? (
      <View style={styles.joinFooter}>
        <Typography variant="bodySm_regular" style={styles.joinNote}>
          {t('forum.channel.joinToPost')}
        </Typography>
      </View>
    ) : undefined

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['top', 'bottom']}
      noPadding
      contentAvoidsKeyboard
      stickyFooter={composer}
    >
      <Stack.Screen options={{headerShown: false}} />
      <View style={styles.header}>
        <ButtonIcon
          icon="chevronLeft"
          size="md"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/community'))}
          containerProps={{accessibilityLabel: t('common.buttons.back')}}
          testID="channel-back"
        />
        <UniIcon name="hash" size="md" uniProps={(theme) => ({color: theme.colors.textMuted})} />
        <View style={styles.headerTitles}>
          <Typography variant="bodyLg_medium" numberOfLines={1}>
            {channelName}
          </Typography>
          {view !== undefined && (
            <Typography variant="bodyXs_regular" numberOfLines={1} style={styles.headerSubtitle}>
              {view.circle.name}
            </Typography>
          )}
        </View>
        {/* Shown only where it will work: the service refuses anyone but the founder, and the default
            stream has no channel row to rename. */}
        {canEditChannel && (
          <ButtonIcon
            icon="settings"
            size="md"
            onPress={() => setEditVisible(true)}
            containerProps={{accessibilityLabel: t('forum.channels.editAccessibilityLabel')}}
            testID="channel-edit"
          />
        )}
      </View>
      <FlatList
        data={timeline}
        keyExtractor={(m) => m.post.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refresh} />}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // Messages are variable-height and there is no `getItemLayout`, so a jump to a row the list
        // has not measured yet throws unless this is handled. Approximating by average row height
        // lands close enough that the target is on screen, and the row is then measured for real.
        onScrollToIndexFailed={({index, averageItemLength}) =>
          stick.ref.current?.scrollToOffset({offset: index * averageItemLength, animated: true})
        }
        {...stick}
        ListEmptyComponent={
          !isLoading && view !== undefined ? (
            <EmptyState
              icon="chat"
              title={t('forum.channel.emptyTitle')}
              description={t('forum.channel.emptyDescription')}
              testID="channel-empty"
            />
          ) : null
        }
      />

      <MessageActionsSheet
        post={actionsFor}
        handles={handles}
        canReply={member !== null}
        onReply={setReplyTo}
        onClose={() => setActionsFor(undefined)}
      />

      <LinkActionSheet
        visible={openRequest !== null}
        onClose={() => setOpenRequest(null)}
        subject={openRequest?.subject ?? null}
        rawLink={openRequest?.raw}
        mine={openRequest?.mine}
      />

      {id !== undefined && activeChannel !== undefined && (
        <ChannelSheet
          circleId={id}
          channel={activeChannel}
          visible={editVisible}
          onClose={() => setEditVisible(false)}
          onSaved={(saved) => {
            refresh()
            // ⚠️ The route segment is the channel's **name**, so a rename leaves this screen pointing
            // at a name no channel has and the transcript renders empty. `replace`, not `push`: the
            // old name is not a place to go back to.
            if (saved.name !== activeChannel.name) {
              router.replace(`/community/${id}/${encodeURIComponent(saved.name)}` as never)
            }
          }}
        />
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  headerTitles: {
    flex: 1,
    minWidth: 0,
  },
  headerSubtitle: {
    color: theme.colors.textMuted,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    gap: theme.spacing.spacing12,
  },
  // Reply reference stacked above an avatar-gutter + text-column row (Discord shape). The reference
  // is a sibling of the row, not a child of the column, so the avatar aligns with the author's name.
  message: {
    paddingVertical: theme.spacing.spacing8,
    gap: theme.spacing.spacing4,
  },
  messageRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: theme.spacing.spacing12,
  },
  messageColumn: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.spacing4,
  },
  // Indented past the avatar so the quoted line starts where the message text does.
  replyReference: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing4,
    marginLeft: AVATAR_SIZE + theme.spacing.spacing12,
  },
  replySpine: {
    width: theme.spacing.spacing16,
    height: 8,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: theme.borderRadius.rounded8,
    borderColor: theme.colors.borderDefaultWeak,
    alignSelf: 'flex-end',
  },
  replyReferenceAuthor: {
    color: theme.colors.primaryDefault,
    flexShrink: 0,
  },
  replyReferenceBody: {
    color: theme.colors.textMuted,
    flexShrink: 1,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.spacing.spacing8,
  },
  messageAuthor: {
    color: theme.colors.primaryDefault,
    flexShrink: 1,
  },
  messageTime: {
    color: theme.colors.textMuted,
  },
  // Footer chrome for the non-member notice. Mirrors MessageComposer's container (which owns the
  // bottom inset for the same reason) without pulling in the input row.
  joinFooter: {
    backgroundColor: theme.colors.backgroundDefault,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderDefaultWeak,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
    paddingBottom: rt.insets.bottom + theme.spacing.spacing8,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
  replyBarText: {
    color: theme.colors.textMuted,
    flexShrink: 1,
  },
  joinNote: {
    color: theme.colors.textMuted,
    textAlign: 'center',
    paddingVertical: theme.spacing.spacing4,
  },
}))
