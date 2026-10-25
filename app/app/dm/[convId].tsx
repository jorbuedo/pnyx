/**
 * A direct-message thread.
 *
 * Everything on screen is decrypted locally: the service holds ciphertext only, and the MLS group
 * state that opens it lives in the encrypted local store (`dm-session.ts`). Two invariants drive
 * the shape of this screen, and both are easy to break by accident:
 *
 * 1. **Group state must be persisted after every operation that advances it** — including receiving
 *    a handshake frame that yields no plaintext. Dropping it desynchronises the ratchet, and MLS
 *    reports that later as an undecryptable message rather than as the write that was missed. So
 *    every seal/open here writes state before the UI updates.
 * 2. **Messages are processed strictly in order, one at a time.** The ratchet is sequential state;
 *    decrypting a batch concurrently would interleave writes and corrupt it.
 *
 * A frame that fails to open is kept and shown as undecryptable rather than dropped silently — the
 * honest signal for a genuine gap (a missed commit, a rotated key) instead of a message that simply
 * never appears.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {Effect, Either} from 'effect'
import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button, ButtonIcon} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {DmConversationMenuSheet} from '../../src/components/forum/DmConversationMenuSheet'
import {DmMessageActionsSheet} from '../../src/components/forum/DmMessageActionsSheet'
import {IdentityAvatar} from '../../src/components/IdentityAvatar'
import {LinkActionCard} from '../../src/components/LinkActionCard'
import {MessageComposer} from '../../src/components/MessageComposer'
import {Modal} from '../../src/components/Modal'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {usePeerHandles} from '../../src/hooks/usePeerHandles'
import {useStickToBottom} from '../../src/hooks/useStickToBottom'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession, useWalletList} from '../../src/providers'
// The context, not the provider: this screen renders below it.
import {useRealtime} from '../../src/providers/realtime-context'
import {LinkActionSheet, type LinkActionSubject} from '../../src/screens/cardano/LinkActionSheet'
import {OwnWalletPickerModal} from '../../src/screens/cardano/multisig/OwnWalletPickerModal'
import {platformPersistCosign, stableCosignId} from '../../src/services/cardano/cosign'
import type {TxEnvelope} from '../../src/services/cardano/cosign/types'
import {packDefinition} from '../../src/services/cardano/multisig/definition-link'
import {buildCoSignerKeyMessage} from '../../src/services/cardano/multisig/dm-message'
import {clearComposerDraft, readComposerDraft} from '../../src/services/composer-draft'
import {dmApi} from '../../src/services/dm-api'
import {captureGrantedPermit, capturePermit, permitToPresent, setConversationMute} from '../../src/services/dm-consent'
import {listDmConversations, rememberDmConversation} from '../../src/services/dm-conversations'
import {deleteDmConversation} from '../../src/services/dm-delete'
import {isLocalSelfConversation} from '../../src/services/dm-local'
import {
  decodeDmState,
  dmCiphersuite,
  dmFrameInfo,
  dmGroupIdOf,
  encodeDmState,
  openDmMessage,
  sealDmMessage,
} from '../../src/services/dm-mls'
import {isConversationMuted} from '../../src/services/dm-permit-book'
import {markConversationRead} from '../../src/services/dm-read'
import {
  appendThread,
  archiveGroupState,
  clearRepairPending,
  clearThread,
  type DmThreadEntry,
  deleteFromThread,
  deriveDmStoreKey,
  loadCursor,
  loadGroupState,
  loadPermitBook,
  loadPriorGroupState,
  loadThread,
  saveCursor,
  saveGroupState,
} from '../../src/services/dm-session'
import {startDmConversation} from '../../src/services/dm-start'
import {dmStartFailureKey} from '../../src/services/dm-start-failure-copy'
import {readLinkAction} from '../../src/services/link-action'
import {formatAuthor} from '../../src/services/pnyx-forum'
import {linkActionSubjectFor} from '../../src/utils/link-action-subject'

/** Matches the forum's 5s poll (`pnyx-forum.ts`), so DMs feel no slower than a channel. */

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

export default function DmThreadScreen() {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {selectedWalletGroup} = useWalletList()
  const {showToast} = useToast()
  const {subscribe} = useRealtime()
  const {forumRoot} = usePnyxSession()
  // `peer` comes from the inbox row. A deep link may not carry it, so it is resolved from the
  // conversation list in that case — the recipient is required to address a message and must never
  // be guessed.
  const {convId, peer: peerParam, draft} = useLocalSearchParams<{convId: string; peer?: string; draft?: string}>()
  const [peer, setPeer] = useState<string | undefined>(peerParam)
  // A one-entry lookup: the same hook the inbox uses, so both surfaces agree on what a peer is
  // called and neither can drift into rendering a name the other would not.
  const peerHandle = usePeerHandles(peer === undefined ? [] : [peer]).get(peer ?? '')
  const [entries, setEntries] = useState<readonly DmThreadEntry[]>([])
  /** Mirrors the permit book; the service is the truth, this is so the menu label reads right. */
  const [muted, setMuted] = useState(false)
  const [muting, setMuting] = useState(false)
  const [blocking, setBlocking] = useState(false)
  /**
   * The two sides are in different MLS groups under this conversation id — read off the framing, not
   * guessed from a decrypt failure. Nothing sent from here can be opened by the peer and nothing they
   * send can be opened here, so the thread has to say so rather than accumulate silent gaps.
   */
  const [diverged, setDiverged] = useState(false)
  // Seeded into the initial state, not through an effect: a message handed to
  // this screen to send is the composer's starting value, and writing it later
  // would overwrite whatever the user had already typed.
  // Seeded from the registry rather than a route param: the body can be a whole
  // transaction envelope, which a URL is the wrong place for.
  const [body, setBody] = useState(() => readComposerDraft(draft) ?? '')
  const [isSending, setIsSending] = useState(false)
  const [noGroup, setNoGroup] = useState(false)
  const [reestablishing, setReestablishing] = useState(false)
  // Guards the ratchet: a poll must never run while a send or an earlier poll is mid-flight.
  const busy = useRef(false)
  const seeded = useRef(false)
  // A thread opens on the last thing said, not the first.
  const stick = useStickToBottom<ScrollView>()

  useEffect(() => {
    if (forumRoot === undefined || peer !== undefined) return
    const root = forumRoot
    void (async () => {
      try {
        // ⚠️ Local index first, server second. The server only lists a conversation while it still
        // holds undelivered messages for it, so a settled conversation has no row there — and
        // sending refuses without a peer, which would make a quiet thread unrepliable.
        const {conversations} = await listDmConversations(session?.token, root)
        setPeer(conversations.find((c) => c.convId === convId)?.peer)
      } catch (error) {
        logger.error('dm peer lookup failed', {origin: 'DmThreadScreen', convId, error})
      }
    })()
  }, [session, forumRoot, peer, convId])

  /**
   * The offline scratchpad: notes on this device, no identity, no group, no service.
   *
   * It takes a different path through both `drain` and `sendText` — there is nothing
   * to poll and nothing to seal — and it is the one thread reachable with no
   * sign-in, which is what makes the action-link cards testable at all.
   */
  const isLocal = convId !== undefined && isLocalSelfConversation(convId)

  /**
   * Remove a message from this device's copy of the thread.
   *
   * Local in both threads, and only a *delete* in the notes one — nothing was ever
   * sent there. For a real conversation the peer keeps their copy, which is what
   * the sheet's own copy says; this does not pretend to reach it.
   */
  const deleteEntry = useCallback(
    async (entry: DmThreadEntry) => {
      if (convId === undefined) return
      // No session means no store key and therefore no thread to edit — the same
      // gate `drain` applies, rather than a second answer to "can we read this".
      //
      // One key for both paths now: the notes thread is sealed with the same `forumRoot`-derived
      // key as every other DM record, so there is nothing left to branch on here.
      if (forumRoot === undefined) return
      try {
        const storeKey = await run(deriveDmStoreKey(forumRoot))
        setEntries(await run(deleteFromThread(storeKey, convId, [entry.id])))
      } catch (error) {
        logger.error('dm delete failed', {origin: 'DmThreadScreen', error})
        showToast({message: t('forum.dm.actions.deleteFailed'), variant: 'error'})
      } finally {
        setActionsFor(undefined)
      }
    },
    [convId, forumRoot, showToast, t],
  )

  /**
   * Take a shared-wallet transaction from a message to the co-sign screen.
   *
   * Filed in the registry first, because that screen loads by id — the same
   * registry the send flow files its own envelopes in, so a transaction that
   * arrived over a DM and one this device built land in the same place and are
   * resumed the same way. The id is derived from the body, so accepting the same
   * request twice is idempotent rather than duplicating it.
   */
  const openCosign = useCallback(
    async (envelope: TxEnvelope) => {
      const groupId = selectedWalletGroup?.groupId
      if (groupId === undefined) {
        // Returning silently made this card the one thing the others no longer are:
        // a tap that does nothing. It is a real precondition, so it is said.
        showToast({message: t('multisig.dm.cosignNoWallet'), variant: 'error'})
        return
      }
      try {
        await Effect.runPromise(platformPersistCosign(groupId, envelope))
        router.push(`/wallet/cosign?pendingId=${encodeURIComponent(stableCosignId(envelope))}` as never)
      } catch (error) {
        logger.error('cosign handoff failed', {origin: 'DmThreadScreen', error})
        showToast({message: t('multisig.dm.cosignOpenFailed'), variant: 'error'})
      }
    },
    [selectedWalletGroup, showToast, t],
  )

  /** Confirm delivery so the ciphertext can be dropped. Never fatal: unacked simply means refetched. */
  const ackFetched = useCallback(async (token: string, ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return
    try {
      const {acked} = await dmApi.ackMessages(token, ids)
      logger.debug('dm messages acked', {origin: 'DmThreadScreen', asked: ids.length, acked})
    } catch (error) {
      logger.warn('dm could not ack delivered messages; they stay on the server and refetch', {
        origin: 'DmThreadScreen',
        count: ids.length,
        error: String(error),
      })
    }
  }, [])

  /**
   * Wipe this conversation's stored plaintext.
   *
   * ⚠️ Leaves the group state alone: clearing history must not end the session, or "clear messages"
   * silently becomes "leave the conversation". The cursor is left alone too — re-fetching what the
   * server still holds would repopulate exactly what was just cleared.
   */
  const clearMessages = useCallback(async () => {
    if (convId === undefined) return
    setClearing(true)
    try {
      await run(clearThread(convId))
      setEntries([])
      setMenuOpen(false)
      showToast({variant: 'success', message: t('forum.dm.menu.cleared')})
      logger.info('dm thread cleared', {origin: 'DmThreadScreen', convId})
    } catch (error) {
      logger.error('dm thread clear failed', {origin: 'DmThreadScreen', convId, error})
      showToast({variant: 'error', message: t('forum.dm.menu.clearFailed')})
    } finally {
      setClearing(false)
    }
  }, [convId, showToast, t])

  /**
   * Remove this conversation from this device: group session, history, inbox row and consent.
   *
   * ⚠️ **The escape hatch that `startDmConversation`'s adoption depends on.** Starting a
   * conversation now reuses existing group state rather than rebuilding, which is what stops a
   * retry claiming another of the peer's KeyPackages — but it also means a conversation whose two
   * sides ended up in *different* groups can never be rebuilt while that state survives. This is
   * what removes it. See `dm-delete.ts`.
   */
  const deleteConversation = useCallback(async () => {
    if (convId === undefined || forumRoot === undefined) return
    setDeleting(true)
    try {
      const outcome = await deleteDmConversation(forumRoot, convId)
      setConfirmDelete(false)
      setMenuOpen(false)
      if (!outcome.ok) {
        // Partly gone is its own state and must not be reported as success: what is left behind
        // decides whether starting again will work.
        logger.error('dm conversation delete incomplete', {origin: 'DmThreadScreen', convId, failed: outcome.failed})
        showToast({variant: 'error', message: t('forum.dm.menu.deleteFailed')})
        return
      }
      showToast({variant: 'success', message: t('forum.dm.menu.deleted')})
      router.back()
    } finally {
      setDeleting(false)
    }
  }, [convId, forumRoot, showToast, t])

  /**
   * Turn notifications for this conversation on or off.
   *
   * ⚠️ Muting is **not** un-accepting: messages keep arriving and the thread keeps updating, the
   * phone just stays quiet. The service enforces it by revoking the permit the peer is reaching us
   * with — see `docs/ABUSE_MITIGATION.md` §5.
   */
  const toggleMute = useCallback(async () => {
    if (convId === undefined || session === undefined || forumRoot === undefined) return
    setMuting(true)
    try {
      const storeKey = await run(deriveDmStoreKey(forumRoot))
      const outcome = await run(setConversationMute(session.token, storeKey, convId, !muted))
      if (outcome === 'no-permit') {
        showToast({variant: 'error', message: t('forum.dm.menu.muteUnavailable')})
        return
      }
      setMuted(outcome === 'muted')
      setMenuOpen(false)
      showToast({
        variant: 'success',
        message: outcome === 'muted' ? t('forum.dm.menu.muted') : t('forum.dm.menu.unmuted'),
      })
    } catch (error) {
      logger.error('dm mute toggle failed', {origin: 'DmThreadScreen', convId, error})
      showToast({variant: 'error', message: t('forum.dm.menu.muteFailed')})
    } finally {
      setMuting(false)
    }
  }, [convId, session, forumRoot, muted, showToast, t])

  /** Refuse everything from this person, now and in future. The peer is never told. */
  const blockPeer = useCallback(async () => {
    if (peer === undefined || session === undefined) return
    setBlocking(true)
    try {
      await dmApi.blockPeer(session.token, peer)
      setMenuOpen(false)
      showToast({variant: 'success', message: t('forum.dm.menu.blocked')})
      logger.info('blocked a peer', {origin: 'DmThreadScreen'})
    } catch (error) {
      logger.error('dm block failed', {origin: 'DmThreadScreen', error})
      showToast({variant: 'error', message: t('forum.dm.menu.blockFailed')})
    } finally {
      setBlocking(false)
    }
  }, [peer, session, showToast, t])

  const drain = useCallback(async () => {
    if (isLocal) {
      // Read the notes and stop. No cursor, no fetch, no ratchet: nothing arrives from anywhere, so
      // there is nothing to reconcile. Keyed to `forumRoot`, which the vault unlock provides — no
      // session, no service.
      if (convId === undefined || seeded.current || forumRoot === undefined) return
      seeded.current = true
      const storeKey = await run(deriveDmStoreKey(forumRoot))
      setNoGroup(false)
      setEntries(await run(loadThread(storeKey, convId)))
      return
    }
    // `forumRoot` is optional on the session; with no root there is no store key and therefore no
    // way to open any thread. Treated as "no session on this device" rather than crashed.
    // ⚠️ `forumRoot`, not a session. The thread's plaintext and the key that opens it are both
    // local, so gating the *read* on a reachable service is what made your own history disappear
    // whenever the app was unlocked but offline.
    if (forumRoot === undefined || convId === undefined || busy.current) return
    busy.current = true
    try {
      const storeKey = await run(deriveDmStoreKey(forumRoot))
      const stored = await run(loadGroupState(storeKey, convId))
      if (stored === undefined) {
        // No group yet: the invite has not been accepted, or this thread was started elsewhere.
        setNoGroup(true)
        return
      }
      setNoGroup(false)
      // Seeded once per mount, via a ref rather than by reading `entries`: depending on the state
      // here would rebuild `drain` on every message and restart the poll interval with it.
      if (!seeded.current) {
        seeded.current = true
        setEntries(await run(loadThread(storeKey, convId)))
        // The menu has to open with the right label, and the book is the only local record of it.
        setMuted(isConversationMuted(await run(loadPermitBook(storeKey)), convId))
      }
      // Everything above is on this device. From here on it needs the service, so with no session
      // the thread reads and stops — history intact, nothing new, rather than nothing at all.
      if (session === undefined) return
      const cursor = await run(loadCursor(convId))
      const fetched = await dmApi.listMessages(session.token, convId, cursor)
      // ⚠️ The only way this device learns the id, and it is what muting names — the service keeps
      // no mapping from a permit to the pair it covers. A new id also means the peer was re-issued
      // one, which un-mutes them, so the mirror follows.
      for (const m of fetched) {
        if (m.permitJti !== undefined) await run(captureGrantedPermit(storeKey, convId, m.permitJti))
      }
      if (fetched.length === 0) return

      const cs = await run(dmCiphersuite())
      let state = await run(decodeDmState(stored))
      const opened: DmThreadEntry[] = []
      for (const message of fetched) {
        // Our own messages come back in the same list, and MLS gives a sender no way to open its
        // own application message — sealing consumed that generation, and processing it here would
        // also double-advance our ratchet. Skip the open, but still move the cursor past it, or the
        // next poll refetches it forever. `send` already put it on screen optimistically.
        if (message.sender === session.identity) {
          // Already stored by `send`, which held the only plaintext this message will ever have.
          await run(saveCursor(convId, message.createdAt))
          continue
        }
        /**
         * ⚠️ **Ask the framing before asking the key.** MLS keeps `group_id` and `epoch` outside the
         * encryption so a message can be routed before it is opened, which makes "this is not my
         * group" a fact rather than an inference. A decrypt failure cannot tell a wrong group from a
         * corrupt ciphertext from a lost ratchet — and it was that ambiguity, not the divergence
         * itself, that let two devices sit in different groups indefinitely with no signal.
         */
        const frame = dmFrameInfo(message.ciphertext)
        const ours = dmGroupIdOf(state)
        if (frame !== undefined && !sameBytes(frame.groupId, ours)) {
          /**
           * Before calling it a divergence: the group we just left. A repair does not reach the peer
           * instantly, so everything they sent between the break and their Welcome arrives addressed
           * to the old group. Those are ordinary messages and the archive is what keeps them
           * readable across the changeover.
           */
          const prior = await run(loadPriorGroupState(storeKey, convId))
          if (prior !== undefined) {
            const priorState = await run(decodeDmState(prior))
            if (sameBytes(frame.groupId, dmGroupIdOf(priorState))) {
              const late = await run(openDmMessage(priorState, message.ciphertext, cs))
              await run(archiveGroupState(storeKey, convId, encodeDmState(late.state)))
              if (late.plaintext !== undefined) {
                const entry: DmThreadEntry = {
                  id: message.id,
                  mine: false,
                  text: new TextDecoder().decode(late.plaintext),
                  createdAt: message.createdAt,
                }
                await run(appendThread(storeKey, convId, [entry]))
                opened.push(entry)
              }
              await run(saveCursor(convId, message.createdAt))
              logger.debug('dm opened a message from the group we just left', {
                origin: 'DmThreadScreen',
                convId,
                id: message.id,
              })
              continue
            }
          }
          setDiverged(true)
          logger.error('dm message belongs to a different group — the two sides have diverged', {
            origin: 'DmThreadScreen',
            convId,
            id: message.id,
            theirs: hex.encode(frame.groupId),
            ours: hex.encode(ours),
          })
          const gap: DmThreadEntry = {id: message.id, mine: false, text: undefined, createdAt: message.createdAt}
          await run(appendThread(storeKey, convId, [gap]))
          await run(saveCursor(convId, message.createdAt))
          continue
        }

        try {
          const result = await run(openDmMessage(state, message.ciphertext, cs))
          state = result.state
          const entry: DmThreadEntry | undefined =
            result.plaintext === undefined
              ? undefined
              : {
                  id: message.id,
                  mine: false,
                  text: new TextDecoder().decode(result.plaintext),
                  createdAt: message.createdAt,
                }
          // Ordered by which failure is survivable, since there is no transaction across the three
          // writes. The plaintext goes first: opening already advanced the ratchet in memory, so a
          // crash before this line loses the message for good, while a crash after it can only
          // duplicate one — and `appendThread` dedupes by id.
          if (entry !== undefined) await run(appendThread(storeKey, convId, [entry]))
          await run(saveGroupState(storeKey, convId, encodeDmState(state)))
          // Reading anything in this group is the confirmation the peer is in it too, which is what
          // retires the tie-break marker.
          await run(clearRepairPending(convId))
          await run(saveCursor(convId, message.createdAt))
          if (entry !== undefined) opened.push(entry)
        } catch (error) {
          logger.error('dm message failed to open', {origin: 'DmThreadScreen', convId, id: message.id, error})
          const gap: DmThreadEntry = {id: message.id, mine: false, text: undefined, createdAt: message.createdAt}
          // Recorded so the gap survives a remount: the ciphertext is unopenable from here on, and
          // showing nothing would silently omit a message the peer believes they sent.
          await run(appendThread(storeKey, convId, [gap]))
          opened.push(gap)
          await run(saveCursor(convId, message.createdAt))
        }
      }
      // Re-read rather than append: the store is deduped and ordered, so taking it as the single
      // source of truth removes any way for React state and disk to drift apart.
      if (opened.length > 0) setEntries(await run(loadThread(storeKey, convId)))
      // ⚠️ Recorded even for a message that would not open. The index orders the inbox and feeds the
      // unread derivation; skipping a frame we could not read would leave the conversation looking
      // older than it is, on the exact frames most worth noticing.
      const newest = fetched.at(-1)?.createdAt
      if (newest !== undefined) {
        await rememberDmConversation(forumRoot, {convId, peer: peer ?? '', lastMessageAt: newest})
      }
      /**
       * ⚠️ **Last, and only after everything above has been written.** Acking is what lets the
       * server drop the ciphertext, and the local thread is the only copy that will ever exist — a
       * sender cannot reopen its own MLS message and this ratchet has already advanced. Acking
       * before persisting would trade a re-fetch for permanent loss.
       *
       * Every fetched id is sent; the server only drops the ones addressed to us. Frames that would
       * not open are included deliberately: the ratchet moved past them, so a redelivery could never
       * do better, and leaving them would redeliver the same failure for ever.
       */
      await ackFetched(
        session.token,
        fetched.map((message) => message.id),
      )
    } catch (error) {
      logger.error('dm thread poll failed', {origin: 'DmThreadScreen', convId, error})
    } finally {
      busy.current = false
    }
  }, [session, forumRoot, convId, isLocal, peer, ackFetched])

  /**
   * Driven by the socket, not by a clock.
   *
   * ⚠️ **This screen was the last thing in DMs still polling** — a fetch every 5 s for the life of
   * an open thread, whether or not anything had arrived, while the inbox and the invite drain had
   * both moved to `dm-waiting` long before. The plan doc's "nothing polls" was already written as if
   * this had too.
   *
   * `dm-waiting` names no conversation (deliberately — see `notifications.ts`), so any DM anywhere
   * drains this thread. That is one fetch, and it is the same trade the inbox already makes.
   *
   * `onOpen` is the catch-up: a reconnect refetches, which is what makes a socket that was down cost
   * latency rather than a missed message. Without it, a drop would silently freeze an open thread.
   */
  useEffect(() => {
    void drain()
    if (isLocal) return
    return subscribe({
      onOpen: () => void drain(),
      onEvent: (event) => {
        if (event.kind !== 'dm-waiting') return
        void drain()
      },
    })
  }, [drain, isLocal, subscribe])

  /**
   * Reading the thread is what marks it read — not fetching it.
   *
   * Keyed on the newest entry, so a message arriving while the screen is open advances the marker
   * too; the unread dot for this conversation clears without the user leaving and coming back. A
   * local-only thread has no server conversation to mark.
   */

  /**
   * Draw a line under everything the replaced session sealed.
   *
   * Two things, and both are about not lying. ⚠️ **The cursor has to move past what is already on
   * the server**, or the very next drain re-fetches an entire history the new epoch can never open
   * and renders one red row per message — which is what re-establishing did on its first outing.
   * And the rows already stored for those messages collapse into a single marker, because "none of
   * this is readable" is one fact, and saying it sixteen times hides it rather than making it clearer.
   *
   * Failure here is logged and swallowed: the session is already live and receiving, which is the
   * thing that was broken. A stale cursor costs noise, not correctness.
   */
  const closeOutOldEpoch = useCallback(
    async (forumRoot: Uint8Array, token: string, id: string): Promise<void> => {
      try {
        const storeKey = await run(deriveDmStoreKey(forumRoot))
        // Oldest first, so the last one is the newest thing the previous session left behind.
        const stale = await dmApi.listMessages(token, id)
        const newest = stale.at(-1)?.createdAt
        if (newest !== undefined) await run(saveCursor(id, newest))
        // ⚠️ Acked as well as skipped. Moving the cursor past them means no drain will ever fetch them
        // again, so anything left unacked here sits on the server for ever — the one place a cursor
        // jump can strand ciphertext that nothing will ever come back for.
        await ackFetched(
          token,
          stale.map((message) => message.id),
        )

        const thread = await run(loadThread(storeKey, id))
        const unreadable = thread.filter((entry) => entry.text === undefined && entry.kind !== 'break')
        if (unreadable.length === 0) return
        await run(
          deleteFromThread(
            storeKey,
            id,
            unreadable.map((entry) => entry.id),
          ),
        )
        await run(
          appendThread(storeKey, id, [
            {
              // Deterministic, so re-establishing twice replaces the marker instead of stacking two.
              id: `session-break:${id}`,
              mine: false,
              text: undefined,
              kind: 'break',
              count: unreadable.length,
              createdAt: newest ?? unreadable[unreadable.length - 1]?.createdAt ?? new Date().toISOString(),
            },
          ]),
        )
        logger.info('dm old epoch closed out', {origin: 'DmThreadScreen', convId: id, collapsed: unreadable.length})
      } catch (error) {
        logger.warn('dm could not close out the old epoch; the thread may show unreadable rows', {
          origin: 'DmThreadScreen',
          convId: id,
          error: String(error),
        })
      }
    },
    [ackFetched],
  )

  /**
   * Ask the peer for a new key and build a fresh session.
   *
   * ⚠️ **The only way out of `noGroup`.** A Welcome is single-use and `takeWelcomes` deletes on read,
   * so a conversation whose invite was consumed by a pass that then failed to join can never be
   * repaired by draining again — the sentence above it was a dead end with nothing to act on. This
   * claims one of the peer's packages and creates a genuinely new group at the same (deterministic)
   * conversation id, which is what `dm-start.ts` does for a first conversation; both sides end up on
   * the new one. Locally stored plaintext is untouched: it is keyed by conversation, not by epoch.
   */
  const reestablish = useCallback(async () => {
    if (session?.forumRoot === undefined || convId === undefined || peer === undefined) {
      logger.warn('dm re-establish unavailable', {
        origin: 'DmThreadScreen',
        convId,
        hasRoot: session?.forumRoot !== undefined,
        hasPeer: peer !== undefined,
      })
      return
    }
    setReestablishing(true)
    const result = await startDmConversation({
      token: session.token,
      selfIdentity: session.identity,
      peerIdentity: peer,
      forumRoot: session.forumRoot,
      network: session.network,
      // Diverged means we hold a group the peer is not in. Adoption would hand that group back and
      // report success, so repair has to say explicitly that it wants a new one.
      rebuild: diverged,
    })
    setReestablishing(false)
    if (!result.ok) {
      logger.error('dm re-establish failed', {origin: 'DmThreadScreen', convId, kind: result.failure.kind})
      showToast({variant: 'error', message: t(dmStartFailureKey(result.failure))})
      return
    }
    logger.info('dm re-established', {origin: 'DmThreadScreen', convId})
    showToast({variant: 'success', message: t('forum.dm.reestablished')})
    await closeOutOldEpoch(session.forumRoot, session.token, convId)
    // Re-seed: the thread has to be read back off the new state, not the one that could not open.
    seeded.current = false
    setNoGroup(false)
    setDiverged(false)
    void drain()
  }, [session, convId, peer, drain, showToast, t, closeOutOldEpoch, diverged])

  /**
   * Repair without being asked.
   *
   * ⚠️ **The bar is that a user never has to know this happened.** Divergence is not a preference
   * or a risk to weigh — it is a conversation that cannot carry messages, and the only useful
   * response is the one the app can take itself. The banner stays, but it reports rather than asks:
   * by the time anyone reads it the rebuild is already running.
   *
   * Once per detection, guarded by the ref: `drain` runs on every poll and every realtime signal,
   * and re-entering here on each one would rebuild the group repeatedly, each rebuild claiming
   * another of the peer's single-use KeyPackages.
   */
  const repairAttempted = useRef(false)
  useEffect(() => {
    if (!diverged || repairAttempted.current || reestablishing) return
    if (session?.forumRoot === undefined || peer === undefined) return
    repairAttempted.current = true
    logger.info('dm repairing a diverged conversation without asking', {origin: 'DmThreadScreen', convId})
    void reestablish()
  }, [diverged, reestablishing, session, peer, convId, reestablish])

  // A repair that failed may succeed later — on a new session, or once the peer's pool refills.
  useEffect(() => {
    if (!diverged) repairAttempted.current = false
  }, [diverged])

  const newestAt = entries.at(-1)?.createdAt
  useEffect(() => {
    if (isLocal || newestAt === undefined) return
    void markConversationRead(convId, newestAt)
  }, [convId, isLocal, newestAt])

  /**
   * Seal and send one message body.
   *
   * Split out from the composer's handler because a multisig reply is the same
   * operation with a body nobody typed — and the ratchet discipline above (seal,
   * persist, then post) must be identical for both or the second path is the one
   * that desynchronises it.
   */
  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      if (convId === undefined || text.trim().length === 0 || busy.current) return false
      if (isLocal) {
        // Straight to the store. There is no ratchet to advance and nowhere to post, so the note is
        // the whole operation — and the id is local because no service is assigning one.
        if (forumRoot === undefined) return false
        busy.current = true
        setIsSending(true)
        try {
          const storeKey = await run(deriveDmStoreKey(forumRoot))
          const note: DmThreadEntry = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            mine: true,
            text,
            createdAt: new Date().toISOString(),
          }
          setEntries(await run(appendThread(storeKey, convId, [note])))
          return true
        } catch (error) {
          logger.error('local note save failed', {origin: 'DmThreadScreen', error})
          return false
        } finally {
          setIsSending(false)
          busy.current = false
        }
      }
      if (forumRoot === undefined) return false
      if (session === undefined) {
        // ⚠️ Reading works without a session; sending does not — the ciphertext has to reach the
        // service for the peer to ever see it. Said out loud, because a send button that silently
        // does nothing is the failure this codebase keeps having to fix.
        logger.warn('dm send aborted: no session', {origin: 'DmThreadScreen', convId})
        showToast({variant: 'error', message: t('forum.dm.sendNoSession')})
        return false
      }
      if (peer === undefined) {
        logger.error('dm send aborted: peer unknown', {origin: 'DmThreadScreen', convId})
        return false
      }
      busy.current = true
      setIsSending(true)
      try {
        const storeKey = await run(deriveDmStoreKey(forumRoot))
        const stored = await run(loadGroupState(storeKey, convId))
        if (stored === undefined) {
          setNoGroup(true)
          return false
        }
        const cs = await run(dmCiphersuite())
        const state = await run(decodeDmState(stored))
        const sealed = await run(sealDmMessage(state, new TextEncoder().encode(text), cs))
        // Persist the advanced ratchet before the network call. If the POST fails the peer never
        // sees this message and we re-send, which is recoverable; reusing a ratchet generation is
        // not.
        await run(saveGroupState(storeKey, convId, encodeDmState(sealed.state)))
        const sent = await dmApi.sendMessage(session.token, convId, {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          recipient: peer,
          ciphertext: sealed.message,
          permit: await run(permitToPresent(storeKey, peer)),
        })
        // ⚠️ The only copy: a permit is stateless, so the service cannot re-issue this one.
        await run(capturePermit(storeKey, peer, sent.permit))
        // The only moment this plaintext exists: MLS gives a sender no way to reopen its own
        // message, so if this is not stored now it is gone.
        const mine: DmThreadEntry = {id: sent.id, mine: true, text, createdAt: sent.createdAt}
        setEntries(await run(appendThread(storeKey, convId, [mine])))
        // Keeps the conversation at the top of an inbox the server no longer orders.
        await rememberDmConversation(forumRoot, {convId, peer, lastMessageAt: sent.createdAt})
        return true
      } catch (error) {
        logger.error('dm send failed', {origin: 'DmThreadScreen', convId, error})
        return false
      } finally {
        setIsSending(false)
        busy.current = false
      }
    },
    [session, forumRoot, convId, peer, isLocal, showToast, t],
  )

  const send = useCallback(async () => {
    // The input clears only on a send that landed; otherwise the text the user
    // typed would be gone along with the message.
    if (await sendText(body)) {
      setBody('')
      // The errand is done; a draft left behind would re-seed the next thread the
      // user opens from a stale id.
      clearComposerDraft()
    }
  }, [body, sendText])

  /**
   * Answer a multisig invite with this wallet's co-signer key.
   *
   * Eligibility is checked before the ceremony, not after: a wallet that holds
   * no signing key cannot satisfy a quorum, and offering the button anyway is
   * the failure `coSignerKeySourceOf` exists to prevent.
   */
  /**
   * The request whose details sheet is open, or `null`.
   *
   * A sheet rather than a screen: the card says what the request is, and everything
   * else — the link string, which wallet pays, whether the network has to change —
   * belongs one tap deeper rather than crowding a message.
   */
  const [openRequest, setOpenRequest] = useState<{
    subject: LinkActionSubject
    raw: string
    mine: boolean
  } | null>(null)
  /** The message whose long-press actions are open, or `undefined`. */
  const [actionsFor, setActionsFor] = useState<DmThreadEntry | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * Which wallet's key to answer with is a question, not a default.
   *
   * ⚠️ This used to derive from whichever wallet happened to be *selected*, so
   * answering a request meant first going to switch wallets and coming back —
   * and sending the wrong key is invisible until an address does not match. Every
   * other link that spends or signs asks the same way (see `link-action` and the
   * co-signer roster editor), and the picker already lists only the wallets whose
   * key can be produced right now.
   */
  const [keyPickerOpen, setKeyPickerOpen] = useState(false)

  const sendCoSignerKey = useCallback(
    async (accountXpubHex: string) => {
      // The key alone. The roster's names belong to whoever assembles it, and this
      // used to send the label of our own funds wallet as the name we go by.
      const message = buildCoSignerKeyMessage(accountXpubHex)
      if (Either.isLeft(message)) {
        logger.warn('dm: could not compose the co-signer key message', {
          origin: 'DmThread',
          reason: message.left,
        })
        showToast({variant: 'error', message: t('multisig.dm.keySendFailed')})
        return
      }
      const sent = await sendText(message.right)
      showToast({
        variant: sent ? 'success' : 'error',
        message: sent ? t('multisig.dm.keySent') : t('multisig.dm.keySendFailed'),
      })
    },
    [sendText, showToast, t],
  )

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['top', 'bottom']}
      noPadding
      contentAvoidsKeyboard
      stickyFooter={
        <MessageComposer
          value={body}
          onChangeText={setBody}
          onSend={() => void send()}
          placeholder={t('forum.dm.composerPlaceholder')}
          sendLabel={t('forum.channel.send')}
          isSending={isSending}
          testIDPrefix="dm-composer"
        />
      }
    >
      <Stack.Screen options={{headerShown: false}} />
      <View style={styles.header}>
        <ButtonIcon
          icon="chevronLeft"
          size="md"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
          containerProps={{accessibilityLabel: t('common.buttons.back')}}
          testID="dm-thread-back"
        />
        {isLocal ? (
          <Typography variant="headingSm" numberOfLines={1} testID="dm-thread-local-title">
            {t('forum.dm.selfOfflineTitle')}
          </Typography>
        ) : peer === undefined ? (
          <Typography variant="headingSm" numberOfLines={1}>
            {t('forum.rail.directMessages')}
          </Typography>
        ) : (
          <>
            <IdentityAvatar pnyxId={peer} size={32} testID="dm-thread-avatar" />
            <View style={styles.headerIdentity}>
              <Typography variant="headingSm" numberOfLines={1}>
                {/* Our own id as the peer is a note to self, not a stranger who
                    happens to share our identicon. */}
                {peer === session?.identity ? t('forum.dm.selfTitle') : (peerHandle ?? formatAuthor(peer, 20))}
              </Typography>
              {/* The id stays on screen whenever a handle replaced it. Handles are confusable by
                  construction — the policy answers script mixing, not lookalikes within one script —
                  so the thing that actually identifies someone must remain visible, not be buried
                  one navigation away. */}
              {peerHandle !== undefined && peer !== session?.identity && (
                <Typography variant="bodyXs_regular" numberOfLines={1} style={styles.headerId} testID="dm-thread-id">
                  {formatAuthor(peer, 20)}
                </Typography>
              )}
            </View>
          </>
        )}
        <View style={styles.headerSpacer} />
        <ButtonIcon
          icon="moreVertical"
          size="md"
          onPress={() => setMenuOpen(true)}
          containerProps={{accessibilityLabel: t('forum.dm.menu.title')}}
          testID="dm-thread-menu"
        />
      </View>
      <DmConversationMenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onClear={entries.length === 0 ? undefined : () => void clearMessages()}
        clearing={clearing}
        // Both are about a *peer*, so neither belongs on the notes thread — it has none.
        onToggleMute={isLocal || peer === undefined ? undefined : () => void toggleMute()}
        muted={muted}
        muting={muting}
        onBlock={isLocal || peer === undefined ? undefined : () => void blockPeer()}
        blocking={blocking}
        // The notes thread has no group and no peer, so there is nothing to delete that `clear`
        // does not already cover.
        onDelete={isLocal ? undefined : () => setConfirmDelete(true)}
        deleting={deleting}
      />
      {/* Worded against what is actually lost, per the menu sheet's own note: the session, not just
          the messages — and that the other side keeps theirs, which is the part nobody expects. */}
      <Modal
        visible={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        position="bottom"
        title={t('forum.dm.menu.deleteConfirmTitle')}
        showDragIndicator
        testID="dm-delete-confirm"
      >
        <View style={styles.confirmBody}>
          <Typography variant="bodySm_regular" style={styles.notice}>
            {t('forum.dm.menu.deleteConfirmBody')}
          </Typography>
          <Button
            label={t('forum.dm.menu.deleteConfirm')}
            variant="secondary"
            isError
            fullWidth
            isLoading={deleting}
            isDisabled={deleting}
            onPress={() => void deleteConversation()}
            testID="dm-delete-confirm-button"
          />
          <Button
            label={t('forum.dm.menu.deleteCancel')}
            variant="nakedDefault"
            fullWidth
            isDisabled={deleting}
            onPress={() => setConfirmDelete(false)}
            testID="dm-delete-cancel"
          />
        </View>
      </Modal>
      <ScrollView contentContainerStyle={styles.list} {...stick}>
        {/* Named, not silent. Before this the same state produced an endless run of unopenable rows
            and no explanation — see `dmFrameInfo`. */}
        {diverged && !noGroup && (
          <View style={styles.noGroupBlock}>
            <Typography variant="bodySm_regular" style={styles.notice} testID="dm-thread-diverged">
              {t('forum.dm.diverged')}
            </Typography>
            <Typography variant="bodyXs_regular" style={styles.notice}>
              {t(reestablishing ? 'forum.dm.divergedHint' : 'forum.dm.divergedStalled')}
            </Typography>
            {/* Only once the automatic attempt has stopped. While it is running there is nothing to
                ask for, and a button that races the repair would spend a second KeyPackage. */}
            {!reestablishing && (
              <Button
                label={t('forum.dm.reestablish')}
                variant="secondary"
                onPress={() => void reestablish()}
                testID="dm-thread-repair"
              />
            )}
          </View>
        )}
        {noGroup && (
          <View style={styles.noGroupBlock}>
            <Typography variant="bodySm_regular" style={styles.notice} testID="dm-thread-no-group">
              {t('forum.dm.noGroup')}
            </Typography>
            <Typography variant="bodyXs_regular" style={styles.notice}>
              {t('forum.dm.reestablishHint')}
            </Typography>
            <Button
              label={t('forum.dm.reestablish')}
              variant="secondary"
              onPress={() => void reestablish()}
              isLoading={reestablishing}
              isDisabled={reestablishing || peer === undefined}
              testID="dm-thread-reestablish"
            />
          </View>
        )}
        {entries.map((entry) => {
          // A break is a divider, not something anyone said — so it gets neither a bubble nor the
          // long-press actions a message has.
          if (entry.kind === 'break') {
            return (
              <Typography
                key={entry.id}
                variant="bodyXs_regular"
                style={styles.notice}
                testID="dm-thread-session-break"
              >
                {t('forum.dm.sessionBreak', {count: entry.count ?? 0})}
              </Typography>
            )
          }
          // Everything that is not one of our action links is conversation. The
          // classification is total, so a person pasting a link is never mistaken
          // for a request for consent.
          const action = entry.text === undefined ? null : readLinkAction(entry.text)
          if (action !== null) {
            const subject = linkActionSubjectFor(action, 'link')
            return (
              <LinkActionCard
                key={entry.id}
                action={action}
                mine={entry.mine}
                busy={isSending}
                onShareKey={() => setKeyPickerOpen(true)}
                onUseKey={() =>
                  router.push(`/wallet/create-multisig?cosignerKey=${encodeURIComponent(entry.text ?? '')}` as never)
                }
                // The whole wallet, arriving from whoever assembled it. The screen
                // reviews the roster and the policy before anything is added — the
                // packed form is what it reads, so the card's own link is passed on.
                onUseWallet={() =>
                  action.kind === 'shared-wallet'
                    ? router.push({
                        pathname: '/wallet/shared-wallet',
                        params: {def: packDefinition(action.definition)},
                      })
                    : undefined
                }
                // Every subject, including `other`. A card whose tap did nothing was
                // indistinguishable from a broken one, and the kinds that offer
                // nothing are the ones that most need to say why. `subject` is null
                // only for a payment with no address, which the classifier already
                // refuses to card.
                onOpenDetails={
                  subject === null
                    ? undefined
                    : () => setOpenRequest({subject, raw: entry.text ?? '', mine: entry.mine})
                }
                onOpenUrl={(url) => router.push({pathname: '/browser', params: {url}})}
                // Route type isn't inferred for the tx group; narrow cast per CLAUDE.md.
                onOpenTransaction={(hash) => router.push(`/wallet/tx/${hash}` as never)}
                onOpenCosign={(envelope) => void openCosign(envelope)}
                onLongPress={() => setActionsFor(entry)}
              />
            )
          }
          return (
            <Pressable
              key={entry.id}
              onLongPress={() => setActionsFor(entry)}
              delayLongPress={300}
              // Long-press is invisible to a screen reader on its own, so the hint
              // is what makes the actions reachable rather than merely present.
              accessibilityRole="button"
              accessibilityHint={t('forum.channel.messageActionsHint')}
              style={[styles.bubble, entry.mine ? styles.bubbleMine : styles.bubbleTheirs]}
            >
              <ChamferBackground
                size="auto"
                cut={entry.mine ? 'diagonalReverse' : 'diagonal'}
                fillToken={entry.mine ? 'backgroundAlternativeHover' : 'backgroundAlternative'}
              />
              {entry.text === undefined ? (
                <Typography variant="bodyXs_regular" style={styles.undecryptable}>
                  {t('forum.dm.undecryptable')}
                </Typography>
              ) : (
                <Typography variant="bodySm_regular">{entry.text}</Typography>
              )}
            </Pressable>
          )
        })}
      </ScrollView>

      <DmMessageActionsSheet
        entry={actionsFor}
        isNotes={isLocal}
        onClose={() => setActionsFor(undefined)}
        onDelete={(entry) => void deleteEntry(entry)}
      />

      <LinkActionSheet
        visible={openRequest !== null}
        onClose={() => setOpenRequest(null)}
        subject={openRequest?.subject ?? null}
        rawLink={openRequest?.raw}
        mine={openRequest?.mine}
      />

      {/* Answering "send me your co-signer key" asks which wallet, like every other
          link that signs. The picker derives on pick, so choosing *is* the consent. */}
      <OwnWalletPickerModal
        visible={keyPickerOpen}
        onClose={() => setKeyPickerOpen(false)}
        takenXpubs={[]}
        onPicked={(picked) => {
          setKeyPickerOpen(false)
          void sendCoSignerKey(picked.accountXpubHex)
        }}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  // `flex: 1` so a long id truncates against the header rather than pushing past the back button.
  // `flex: 1` belongs on the column, not on the title inside it: with two stacked children the flex
  // algorithm would size the title by leftover *vertical* space, and `numberOfLines={1}` then clipped
  // descenders off names like "testerp". `minWidth: 0` is what lets the single line truncate instead
  // of pushing the row wide — same shape as the channel header.
  headerIdentity: {flex: 1, minWidth: 0},
  headerId: {color: theme.colors.textAlternative},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  list: {padding: theme.spacing.spacing12, gap: theme.spacing.spacing8},
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },
  bubbleMine: {alignSelf: 'flex-end'},
  bubbleTheirs: {alignSelf: 'flex-start'},
  headerSpacer: {flex: 1},
  noGroupBlock: {gap: theme.spacing.spacing8, paddingHorizontal: theme.spacing.spacing16},
  notice: {color: theme.colors.textAlternative, textAlign: 'center'},
  confirmBody: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing12,
  },
  undecryptable: {color: theme.colors.errorDefault, fontStyle: 'italic'},
}))
