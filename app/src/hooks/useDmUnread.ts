/**
 * Which conversations are unread, as attention dots and as an arrival announcement.
 *
 * The list is re-read on the same three triggers as the invite drain — sign-in, a socket open, and a
 * `dm-waiting` signal — so a dot appears the moment a message lands rather than the next time the
 * inbox happens to mount. Unread itself is derived (`dm-unread`), never counted, so the same arrival
 * reaching the app twice cannot inflate it.
 *
 * ⚠️ **This fetches `/dm` even though the inbox pane also does.** There is no shared conversation
 * store yet, and the dot has to work while the inbox is not mounted — which is most of the time, and
 * exactly when a dot is the only thing telling the user to go there.
 *
 * @module
 */

import {usePathname} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {logger} from '../logger'
import {useRegisterNoticeSet} from '../notices'
import {useI18n} from '../providers'
import {useRealtime} from '../providers/realtime-context'
import type {DmConversation} from '../services/dm-conversation-index'
import {listDmConversations} from '../services/dm-conversations'
import {syncDmNotificationRows} from '../services/dm-notification-sync'
import {loadReadMarkers, onReadMarkersChanged} from '../services/dm-read'
import {type ConversationTimes, newlyArrived, unreadConversations} from '../services/dm-unread'
import {forgetPeerHandle} from '../services/peer-label'
import {formatAuthor} from '../services/pnyx-forum'
import type {PnyxSession} from '../services/pnyx-session'
import {usePeerHandles} from './usePeerHandles'
import {useToast} from './useToast'

const ORIGIN = 'useDmUnread'

/** Stable, because the registry identifies what to clear by these. */
const keyOf = (convId: string): string => `dm-unread:${convId}`
const routeOf = (convId: string): string => `/dm/${convId}`

export const useDmUnread = (session: PnyxSession | undefined, forumRoot: Uint8Array | undefined): void => {
  const {subscribe} = useRealtime()
  const {showToast} = useToast()
  const {t} = useI18n()
  const pathname = usePathname()
  const [unread, setUnread] = useState<readonly string[]>([])
  const [conversations, setConversations] = useState<readonly DmConversation[]>([])
  // Bumped on every recomputation so the rows are reconciled even when the unread *set* did not
  // change — a stray row can be written after the last change (a notification tap used to write one).
  const [syncTick, setSyncTick] = useState(0)
  const previous = useRef<readonly ConversationTimes[] | undefined>(undefined)
  // Read at announcement time rather than closed over, so the effect does not restart on navigation.
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  const refresh = useCallback(
    async (token: string | undefined, forumRoot: Uint8Array) => {
      try {
        const {conversations} = await listDmConversations(token, forumRoot)
        setConversations(conversations)
        const times: readonly ConversationTimes[] = conversations.map((c) => ({
          convId: c.convId,
          lastMessageAt: c.lastMessageAt,
        }))
        const markers = await loadReadMarkers(times.map((c) => c.convId))
        const next = unreadConversations(times, markers)
        setUnread(next)
        // Only a conversation that actually moved is news; one that is merely still unread already
        // has its dot, and announcing it on every refetch would toast on a timer.
        const arrived = newlyArrived(previous.current, times).filter(
          (convId) => !pathnameRef.current.startsWith(`/dm/${convId}`),
        )
        // Someone who just messaged you is the likeliest person to have just claimed a name, and the
        // one whose name you most want right. Forgetting them turns the next lookup into a read
        // instead of waiting out the height-trust window.
        for (const convId of newlyArrived(previous.current, times)) {
          const peer = conversations.find((c) => c.convId === convId)?.peer
          if (peer !== undefined) forgetPeerHandle(peer)
        }
        previous.current = times
        setSyncTick((tick) => tick + 1)
        logger.debug('dm unread recomputed', {origin: ORIGIN, unread: next.length, announced: arrived.length})
        if (arrived.length > 0) showToast({message: t('forum.dm.toast.newMessage'), variant: 'info'})
      } catch (error) {
        // The dots keep their last value: a failed read must not clear an unread mark and hide a
        // conversation the user has not seen.
        logger.warn('dm unread refresh failed', {origin: ORIGIN, error: String(error)})
      }
    },
    [showToast, t],
  )

  /**
   * Re-derive from the list we already have, because only the markers moved.
   *
   * Reading a thread must clear its dot immediately; refetching `/dm` to learn something the device
   * already knows would put a network round trip between the user and the dot going out.
   */
  const rederive = useCallback(async () => {
    const times = previous.current
    if (times === undefined) return
    const markers = await loadReadMarkers(times.map((c) => c.convId))
    const next = unreadConversations(times, markers)
    setUnread(next)
    setSyncTick((tick) => tick + 1)
    logger.debug('dm unread re-derived after a read marker moved', {origin: ORIGIN, unread: next.length})
  }, [])

  useEffect(() => onReadMarkersChanged(() => void rederive()), [rederive])

  useEffect(() => {
    // ⚠️ Gated on `forumRoot`, not on a session. Both halves of the derivation are local — the
    // index's `lastMessageAt` and the read markers — so an unlocked app with no session still knows
    // what it has not read. Requiring a session cleared every dot the moment the service went away.
    if (forumRoot === undefined) {
      setUnread([])
      setConversations([])
      previous.current = undefined
      return
    }
    const token = session?.token
    void refresh(token, forumRoot)
    // With no session there is no socket either, so the local answer above is the whole answer.
    if (token === undefined) return
    return subscribe({
      onOpen: () => void refresh(token, forumRoot),
      onEvent: (event) => {
        if (event.kind === 'dm-waiting') void refresh(token, forumRoot)
      },
    })
  }, [session, forumRoot, subscribe, refresh])

  /**
   * Name the sender in the notification centre, which the push itself cannot do.
   *
   * The peer's handle is resolved here rather than carried in the payload — see
   * {@link module:../services/dm-notification-rows} for why nothing about the conversation may ride
   * on the wire.
   */
  const unreadPeers = unread.map((convId) => conversations.find((c) => c.convId === convId)?.peer ?? '')
  const handles = usePeerHandles(unreadPeers.filter((peer) => peer !== ''))
  const rowsKey = unread
    .map((convId) => {
      const conversation = conversations.find((c) => c.convId === convId)
      return `${convId}:${conversation?.lastMessageAt ?? ''}:${handles.get(conversation?.peer ?? '') ?? ''}`
    })
    .join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rowsKey` is the digest of `unread`, `conversations` and `handles`; listing those re-syncs the notification centre on every render, which the digest exists to prevent.
  useEffect(() => {
    const rows = unread.flatMap((convId) => {
      const conversation = conversations.find((c) => c.convId === convId)
      if (conversation === undefined) return []
      const peer = conversation.peer
      return [
        {
          convId,
          lastMessageAt: conversation.lastMessageAt,
          label: handles.get(peer) ?? formatAuthor(peer, 20),
        },
      ]
    })
    void syncDmNotificationRows(
      rows,
      (peer) => t('forum.dm.notification.from', {peer}),
      t('forum.dm.notification.body'),
    )
    // `rowsKey` collapses the inputs so a re-render alone does not re-run the sync; `syncTick` is what
    // makes every recomputation reconcile, which is how a row written since the last one is cleared.
  }, [rowsKey, syncTick, t])

  useRegisterNoticeSet(keyOf, routeOf, unread)
}
