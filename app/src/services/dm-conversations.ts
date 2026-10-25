/**
 * The conversation list the app reads, and the writes that keep it true.
 *
 * One entry point over two sources: the sealed local index (identity, peer, ordering) and whatever
 * the server still holds (what is *waiting*). Every screen goes through here so there is one merge
 * rule rather than one per caller — the rule itself is pure, in `dm-conversation-index.ts`.
 *
 * ⚠️ **Writes are best-effort and never block what they follow.** Remembering a conversation is
 * bookkeeping; sending a message, joining a group and reading a thread are the product. A failed
 * write costs a row that reappears on the next server merge, so it is logged and swallowed — but it
 * *is* logged, because an index that silently stopped updating looks exactly like a quiet inbox.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {dmApi} from './dm-api'
import {type DmConversation, mergeServerPending, sortConversations, upsertConversation} from './dm-conversation-index'
import {
  adoptSyncedConversationIndex,
  deriveDmStoreKey,
  loadConversationIndex,
  mirrorConversationIndex,
  saveConversationIndex,
} from './dm-session'

const ORIGIN = 'dm-conversations'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

/**
 * Read the index alone, treating a corrupt one as empty *after saying so*.
 *
 * A store sealed under a key this build cannot derive is unrecoverable, and the alternative — letting
 * it throw — would take the whole inbox down rather than degrade it to what the server still knows.
 */
const readIndex = async (forumRoot: Uint8Array): Promise<readonly DmConversation[]> => {
  try {
    // A restored device has no index of its own. This is the only thing that tells it who it was
    // talking to before the service happens to deliver something.
    await run(adoptSyncedConversationIndex())
    const storeKey = await run(deriveDmStoreKey(forumRoot))
    return await run(loadConversationIndex(storeKey))
  } catch (error) {
    logger.warn('dm conversation index unreadable; falling back to what the server still holds', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
}

/**
 * Every conversation this device knows about, newest first.
 *
 * ⚠️ **The server half is not a second opinion about who you talk to** — it is the undelivered queue.
 * A conversation drops out of it as soon as its messages are delivered, which is exactly when this
 * device no longer needs to be told about it. Merging the two is what lets a restored device see a
 * conversation it has no index entry for, without the server holding a permanent record of the graph.
 */
export type DmConversationList = {
  readonly conversations: readonly DmConversation[]
  /**
   * How complete this answer is — so a caller can tell apart three states that would otherwise all
   * render as an empty list.
   *
   * - `merged` — the service was asked and answered. Empty means you have no conversations.
   * - `skipped` — no session, so it was never asked. Everything on this device is here; anything
   *   still waiting on the server is not.
   * - `unavailable` — asked, and could not be reached. Same content as `skipped`, different cause,
   *   and only one of them is something the user can act on.
   */
  readonly pending: 'merged' | 'skipped' | 'unavailable'
}

export const listDmConversations = async (
  token: string | undefined,
  forumRoot: Uint8Array,
): Promise<DmConversationList> => {
  const local = await readIndex(forumRoot)
  if (token === undefined) {
    // ⚠️ Neither an error nor an empty inbox. `forumRoot` comes from the vault unlock, so the index
    // is readable independently of a session — and refusing to render it is what made an
    // unlocked-but-offline app show nothing at all. That state is designed for: `signInForUnlock`
    // reports the enclave leg separately so unlock survives an unreachable service.
    logger.debug('dm conversations listed from the index alone; no session to ask with', {
      origin: ORIGIN,
      local: local.length,
    })
    return {conversations: sortConversations(local), pending: 'skipped'}
  }
  try {
    const pending = await dmApi.listConversations(token)
    const merged = mergeServerPending(
      local,
      pending.map((one) => ({convId: one.convId, peer: one.peer, lastMessageAt: one.lastMessageAt})),
    )
    // ⚠️ **Backfill, and it is a prerequisite rather than a nicety.** A device that predates the
    // index has none, so today it is carried entirely by the server list — which is fine only while
    // nothing is deleted. The day delivered ciphertext starts being dropped, every conversation that
    // had settled without being touched again would vanish. Writing the merge back the first time
    // captures them while the server can still name them.
    if (local.length === 0 && merged.length > 0) {
      await persistIndex(forumRoot, merged, 'backfilled the conversation index from the server')
    }
    return {conversations: merged, pending: 'merged'}
  } catch (error) {
    // The local index is the answer; the server only adds what is waiting. Degraded, not broken.
    logger.warn('dm pending fetch failed; listing from the local index alone', {
      origin: ORIGIN,
      error: String(error),
      local: local.length,
    })
    return {conversations: sortConversations(local), pending: 'unavailable'}
  }
}

/** Seal and write the index, reporting the outcome either way. */
const persistIndex = async (forumRoot: Uint8Array, list: readonly DmConversation[], why: string): Promise<void> => {
  try {
    const storeKey = await run(deriveDmStoreKey(forumRoot))
    await run(saveConversationIndex(storeKey, list))
    // The synced copy is what survives a restore; mirroring on every write keeps it from drifting
    // into a snapshot of whenever it was last thought about.
    await run(mirrorConversationIndex())
    logger.info(why, {origin: ORIGIN, size: list.length})
  } catch (error) {
    logger.warn('dm conversation index write failed; the rows return on the next server merge', {
      origin: ORIGIN,
      why,
      error: String(error),
    })
  }
}

/**
 * Record that a conversation exists, or that it just moved.
 *
 * Called wherever a conversation is created, joined, sent to, or received from. `peer` may be `''`
 * when the caller knows the id but not the party — the merge keeps whatever was already stored.
 */
export const rememberDmConversation = async (forumRoot: Uint8Array, entry: DmConversation): Promise<void> => {
  try {
    const storeKey = await run(deriveDmStoreKey(forumRoot))
    const current = await run(loadConversationIndex(storeKey))
    const next = upsertConversation(current, entry)
    // `upsert` is monotonic in `lastMessageAt`, so an unchanged list means nothing moved — skipping
    // the write keeps a poll from rewriting the same sealed blob on every tick.
    if (next.length === current.length && next[0]?.lastMessageAt === current[0]?.lastMessageAt) {
      const before = current.find((one) => one.convId === entry.convId)
      const after = next.find((one) => one.convId === entry.convId)
      if (before?.lastMessageAt === after?.lastMessageAt && before?.peer === after?.peer) return
    }
    await run(saveConversationIndex(storeKey, next))
    await run(mirrorConversationIndex())
    logger.debug('dm conversation index updated', {origin: ORIGIN, convId: entry.convId, size: next.length})
  } catch (error) {
    logger.warn('dm conversation index write failed; the row returns on the next server merge', {
      origin: ORIGIN,
      convId: entry.convId,
      error: String(error),
    })
  }
}
