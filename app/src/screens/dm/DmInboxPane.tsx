/**
 * Direct-message inbox — the right pane when the rail's DM slot is selected.
 *
 * Shows conversations from `GET /dm` and nothing it cannot back with real data: the list is
 * metadata only (peer + last activity), because previews would require decrypting each thread's
 * latest message, which means loading its MLS state. That is thread-screen work, not list work.
 *
 * The avatar is the one exception that costs nothing: it is a pure function of the peer's `pnyx_id`
 * (`IdentityAvatar` seeds from the decoded bytes of `C`), so it needs no fetch and no key material.
 * `peer` really is a `pnyx_id` — the service writes `sender: subject` from the JWT — so it decodes
 * rather than falling back to the placeholder icon.
 *
 * Tapping a row pushes `/dm/[convId]` rather than swapping the pane inline: a thread has a
 * composer, keyboard avoidance and a growing list, and community channels already work that way.
 *
 * **Notes to self are anchored above the list rather than living in it.** One thread, local, needing
 * no identity — so it is drawn before anything else on the pane, including the sign-in card, and the
 * self-conversation is filtered out of the listed rows or it would appear twice.
 *
 * ⚠️ **What this pane needs is the vault, not a session.** The index is sealed under the unlock's
 * `forumRoot`, so the sign-in card stands in only when there is no root or no known identity to read
 * with. With those and no session the rows are drawn and labelled as this device's own
 * (`pending: 'skipped'`); the `+` is the single affordance held back, because starting a
 * conversation fetches the peer's key package and that genuinely needs the service.
 *
 * @module
 */

import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button, ButtonIcon} from '../../components/Buttons'
import {EmptyState} from '../../components/EmptyState'
import {SignInCard} from '../../components/forum/SignInCard'
import {IdentityAvatar} from '../../components/IdentityAvatar'
import {OfficialMark} from '../../components/OfficialMark'
import {TextInput} from '../../components/TextInput'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useFormatDate} from '../../hooks/useFormatDate'
import {useOfficialIdentities} from '../../hooks/useOfficialIdentities'
import {usePeerHandles} from '../../hooks/usePeerHandles'
import {logger} from '../../logger'
import {NoticeDot} from '../../notices'
import {useI18n, usePnyxSession} from '../../providers'
// The context, not the provider: this screen renders below it, but the provider's chain imports
// this tree back.
import {useRealtime} from '../../providers/realtime-context'
import type {DmConversation} from '../../services/dm-conversation-index'
import type {DmConversationList} from '../../services/dm-conversations'
import {listDmConversations} from '../../services/dm-conversations'
import {LOCAL_SELF_CONV_ID} from '../../services/dm-local'
import {isOfficialIdentity} from '../../services/official-identity'
import {formatAuthor} from '../../services/pnyx-forum'
import {dmInboxAccess} from './inbox-access'
import {listedConversations, searchedConversations} from './inbox-rows'

export function DmInboxPane() {
  const {t} = useI18n()
  // A message another surface wants sent into one of these conversations —
  // today, a shared-wallet invitation composed on the create screen.
  const {draft} = useLocalSearchParams<{draft?: string}>()
  const {session, forumRoot, identity} = usePnyxSession()
  const {subscribe} = useRealtime()
  const {formatDateTime} = useFormatDate()
  const [conversations, setConversations] = useState<readonly DmConversation[] | undefined>(undefined)
  /**
   * Why the list is what it is — three states that all render as "no rows" if collapsed.
   *
   * `merged` the service answered; `skipped` there was no session to ask with; `unavailable` it was
   * asked and could not be reached. Only the last is an error, and only the last two mean the list
   * may be incomplete.
   */
  const [pending, setPending] = useState<DmConversationList['pending']>('merged')
  /**
   * Whether the search field is open, and what is in it.
   *
   * ⚠️ **Closing clears the query.** A filter left applied behind a collapsed field is a list that
   * silently hides rows, which is indistinguishable from conversations having disappeared.
   */
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const toggleSearch = useCallback(() => {
    setSearching((open) => {
      if (open) setQuery('')
      return !open
    })
  }, [])

  const load = useCallback(async (token: string | undefined, forumRoot: Uint8Array) => {
    try {
      // The local index, merged with whatever the server still holds undelivered — see
      // `dm-conversations.ts` for why the server half is a queue and not a conversation list.
      const result = await listDmConversations(token, forumRoot)
      setConversations(result.conversations)
      setPending(result.pending)
    } catch (error) {
      // Surfaced as an error row rather than an empty list: "you have no conversations" and "we
      // could not reach the service" must not look identical.
      logger.error('dm inbox load failed', {origin: 'DmInboxPane', error})
      setPending('unavailable')
    }
  }, [])

  useEffect(() => {
    // ⚠️ Gated on `forumRoot`, not on a session: the index is local and readable from the vault
    // unlock onward, so requiring a session is what made an unlocked-but-offline app show an empty
    // inbox rather than the conversations sitting on its own disk.
    if (forumRoot === undefined) return
    const token = session?.token
    const root = forumRoot
    void load(token, root)
    // No session, no socket — the local read above is the whole answer.
    if (token === undefined) return
    /**
     * ⚠️ **The list is not live without this.** `dm-waiting` says something is queued for us; the
     * invite drain reacts to it, but nothing re-read the conversations — so a message in a
     * conversation that already exists left this list showing its previous state while the app sat
     * open on this very screen. The signal names no conversation (deliberately), so the answer is to
     * re-read the list the screen already reads.
     */
    return subscribe({
      onOpen: () => void load(token, root),
      onEvent: (event) => {
        if (event.kind !== 'dm-waiting') return
        logger.debug('re-reading the inbox on a dm signal', {origin: 'DmInboxPane'})
        void load(token, root)
      },
    })
  }, [session, forumRoot, load, subscribe])

  /**
   * Re-run the read behind the `unavailable` notice.
   *
   * The sign-in retry is `SignInCard`'s own button; this one is for the other failure — a session
   * that exists whose pending fetch did not answer — where signing in again would fix nothing.
   */
  const retryLoad = useCallback(() => {
    if (forumRoot === undefined) return
    void load(session?.token, forumRoot)
  }, [load, session, forumRoot])

  /**
   * Open the notes thread. One navigation, always.
   *
   * ⚠️ **There is no signed-in variant any more.** A note to self posts nothing, fetches nothing and
   * renders from a local store, so the network sign-in it used to require bought it exactly two
   * things: an MLS group that encrypted nothing, and a `forumRoot`-derived at-rest key — which is no
   * more recoverable than a device-local one, because nothing backs this store up. What it cost was
   * a *second thread*: notes written signed out became invisible on sign-in, still on disk under the
   * other key. One thread, one store, no session.
   */
  const openNotes = useCallback(() => {
    const carried = typeof draft === 'string' && draft !== '' ? {draft} : {}
    router.push({pathname: '/dm/[convId]', params: {convId: LOCAL_SELF_CONV_ID, ...carried}})
  }, [draft])

  const notesRow = (
    <Pressable
      onPress={openNotes}
      accessibilityRole="button"
      accessibilityLabel={t('forum.dm.selfOfflineTitle')}
      style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
      testID="dm-note-to-self"
    >
      <View style={styles.notesAvatar}>
        <UniIcon name="fileText" size="sm" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
      </View>
      <View style={styles.rowText}>
        <Typography variant="bodyMd_medium" numberOfLines={1}>
          {t('forum.dm.selfOfflineTitle')}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.muted} numberOfLines={1}>
          {t('forum.dm.selfOfflineHint')}
        </Typography>
      </View>
    </Pressable>
  )

  const {canRead, selfIdentity, canStart} = dmInboxAccess({
    hasForumRoot: forumRoot !== undefined,
    storedIdentity: identity?.pnyxId,
    sessionIdentity: session?.identity,
  })

  // Above the signed-out return because it feeds a hook, and a hook cannot sit after a conditional
  // one. Guarded for the same reason rather than relying on the return below.
  const peers =
    conversations === undefined || selfIdentity === undefined
      ? undefined
      : listedConversations(conversations, selfIdentity)
  // ⚠️ Retried on the session token: a list first drawn with no session resolved no handles at all, and
  // without this it kept drawing ids after signing back in.
  //
  // ⚠️ Resolved for **every** conversation, not the filtered ones: the query matches handles, so a
  // handle that only resolves once its row survives the filter could never bring that row through it.
  const official = useOfficialIdentities()
  const handles = usePeerHandles(peers?.map((conversation) => conversation.peer) ?? [], session?.token)
  const visible = peers === undefined ? undefined : searchedConversations(peers, query, handles)

  // ⚠️ **Not `session === undefined`.** The index, the read markers and the sealed threads are all
  // local and open with the vault's `forumRoot`, so gating the render on a session hid every
  // conversation on the device in exactly the state the unlock is built to survive — an unreachable
  // service. What is genuinely unavailable here is *starting* a conversation, which is why the
  // header's `+` is the one thing still gated on a session.
  if (!canRead) {
    return (
      <View style={styles.panel}>
        <View style={styles.header}>
          <Typography variant="headingSm">{t('forum.rail.directMessages')}</Typography>
        </View>
        {/* Anchored above the sign-in card, not below it: the notes thread is the one
            thing on this pane that works without an identity, and it stops being an
            offer if you have to read past a prompt to sign in to find it. */}
        <View style={styles.anchor}>{notesRow}</View>
        <View style={styles.empty}>
          <SignInCard testID="dm-sign-in" />
        </View>
      </View>
    )
  }

  return (
    <View style={styles.panel}>
      {/*
        ⚠️ **The notice takes the header's place rather than a slice of the list.** Both states it
        reports are about reaching the service, and the header is where reaching it is offered — the
        `+` starts a conversation, the strip's button retries the sign-in that would allow one. Put
        below the header instead, it pushed the conversations down the screen and made an inbox that
        is entirely readable look like a broken one.
      */}
      <View style={styles.header}>
        {pending === 'skipped' ? (
          <View style={styles.notice}>
            <SignInCard compact message={t('forum.dm.localOnly')} testID="dm-sign-in" />
          </View>
        ) : pending === 'unavailable' ? (
          <View style={styles.notice}>
            <View style={styles.noticeText}>
              <Typography variant="bodyXs_regular" style={styles.error} numberOfLines={2} testID="dm-inbox-error">
                {t('forum.dm.unreachable')}
              </Typography>
            </View>
            <Button
              label={t('forum.dm.retry')}
              variant="secondary"
              size="sm"
              onPress={retryLoad}
              testID="dm-inbox-retry"
            />
          </View>
        ) : (
          <>
            <Typography variant="headingSm">{t('forum.rail.directMessages')}</Typography>
            <View style={styles.headerActions}>
              {/* Gated on `canStart` — the same "is there a session" question, reused rather than
                  restated. Every section of that screen is a service call (policy, invitations,
                  blocks), so with no session it has nothing to draw. */}
              {canStart ? (
                <ButtonIcon
                  icon="settings"
                  size="sm"
                  onPress={() => router.push('/settings/messaging')}
                  containerProps={{accessibilityLabel: t('forum.dm.settings')}}
                  testID="dm-settings"
                />
              ) : null}
              <ButtonIcon
                icon={searching ? 'close' : 'search'}
                size="sm"
                onPress={toggleSearch}
                containerProps={{
                  accessibilityLabel: searching ? t('forum.dm.searchClose') : t('forum.dm.search'),
                }}
                testID="dm-search-toggle"
              />
              {/* Reading is local; starting is not — fetching a peer's key package needs the service.
                  Gated on the session rather than on `pending` so it never flashes before the first
                  read reports which state this is. */}
              {/* ⚠️ The real defence against a lookalike support account: the user never types a
                  name and never judges who answered. It opens the compose screen prefilled with the
                  configured id, so the existing start-a-conversation path does the work. Hidden
                  when no support id is configured rather than disabled — an affordance that cannot
                  act is a promise the app does not keep. */}
              {canStart && official.support !== undefined ? (
                <ButtonIcon
                  icon="shieldCheck"
                  size="sm"
                  onPress={() => router.push({pathname: '/dm/new', params: {peer: official.support}})}
                  containerProps={{accessibilityLabel: t('forum.dm.askSupport')}}
                  testID="dm-ask-support"
                />
              ) : null}
              {canStart ? (
                <ButtonIcon
                  icon="plus"
                  size="sm"
                  onPress={() => router.push('/dm/new')}
                  containerProps={{accessibilityLabel: t('forum.dm.newMessage')}}
                  testID="dm-new-message"
                />
              ) : null}
            </View>
          </>
        )}
      </View>
      {/* Below the header rather than inside it: the field wants the full width, and the notes row
          stays anchored under it so search never pushes the one always-available thread off screen. */}
      {searching ? (
        <View style={styles.search}>
          <TextInput
            fullWidth
            leftIcon="search"
            placeholder={t('forum.dm.searchPlaceholder')}
            value={query}
            onChange={setQuery}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            testID="dm-search-input"
          />
        </View>
      ) : null}
      <View style={styles.anchor}>{notesRow}</View>
      {visible === undefined ? null : visible.length === 0 && query.trim() !== '' ? (
        <View style={styles.empty}>
          <Typography variant="bodySm_regular" style={styles.muted} testID="dm-search-no-matches">
            {t('forum.dm.noMatches')}
          </Typography>
        </View>
      ) : visible.length === 0 && pending === 'merged' ? (
        <View style={styles.empty}>
          <EmptyState
            icon="chat"
            title={t('forum.dm.emptyTitle')}
            description={t('forum.dm.emptyDescription')}
            testID="dm-inbox-empty"
          />
          <Button
            label={t('forum.dm.startAction')}
            variant="primary"
            onPress={() => router.push('/dm/new')}
            testID="dm-empty-start"
          />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {visible.map((conversation) => (
            <Pressable
              key={conversation.convId}
              onPress={() =>
                router.push({
                  pathname: '/dm/[convId]',
                  params: {
                    convId: conversation.convId,
                    peer: conversation.peer,
                    // Carried through rather than sent from here: picking who to
                    // ask and sending the ask are two decisions, and the second
                    // one belongs in the thread where the message is visible. An
                    // id, not the body — it can be a whole transaction envelope.
                    ...(typeof draft === 'string' && draft !== '' ? {draft} : {}),
                  },
                })
              }
              accessibilityRole="button"
              // The id, always — a screen reader announcing a handle would inherit every
              // confusability the visual pairing with the identicon is there to answer.
              accessibilityLabel={conversation.peer}
              style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
              testID={`dm-conversation-${conversation.convId}`}
            >
              <IdentityAvatar
                pnyxId={conversation.peer}
                size={40}
                testID={`dm-conversation-avatar-${conversation.convId}`}
              />
              <View style={styles.rowText}>
                {/* The mark sits with the name, not with the avatar: it is a claim about *who this
                    is*, and the avatar already carries the identicon that answers confusability. */}
                <View style={styles.rowName}>
                  <Typography variant="bodyMd_medium" numberOfLines={1}>
                    {handles.get(conversation.peer) ?? formatAuthor(conversation.peer, 20)}
                  </Typography>
                  {isOfficialIdentity(conversation.peer, official) ? (
                    <OfficialMark testID={`dm-official-${conversation.convId}`} />
                  ) : null}
                </View>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {formatDateTime(new Date(conversation.lastMessageAt), {dateStyle: 'short', timeStyle: 'short'})}
                </Typography>
              </View>
              {/* The middle of the trail: Community tab → this row → the thread. */}
              <NoticeDot
                route={`/dm/${conversation.convId}`}
                position="static"
                testID={`dm-unread-${conversation.convId}`}
              />
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  panel: {flex: 1, backgroundColor: theme.colors.backgroundAlternative},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  // Fills the header row it stands in for, so its own button lands where the `+` would have.
  notice: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing12,
  },
  noticeText: {flex: 1},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing16},
  search: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  // Outside the ScrollView, so the notes row stays put however long the list gets — the divider is
  // what makes it read as anchored rather than as the first of many.
  anchor: {
    padding: theme.spacing.spacing8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  // The panel is already `backgroundAlternative`, so the disc needs a step away from it to read as
  // an avatar at all — unlike `IdentityAvatar`, whose SVG fills the circle.
  notesAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: theme.colors.backgroundAlternativeHover,
  },
  list: {padding: theme.spacing.spacing8, gap: theme.spacing.spacing4},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    gap: theme.spacing.spacing12,
  },
  // `flex: 1` so a long id truncates against the row rather than pushing the timestamp out; the
  // avatar already refuses to shrink.
  rowName: {flexDirection: 'row', alignItems: 'center', gap: 4},
  rowText: {flex: 1, gap: theme.spacing.spacing4},
  // Pressed feedback dims rather than filling: the row has no painted surface of
  // its own, so a rect fill would show square corners against the chamfered list.
  rowPressed: {opacity: 0.6},
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  error: {color: theme.colors.errorDefault},
  muted: {color: theme.colors.textAlternative},
}))
