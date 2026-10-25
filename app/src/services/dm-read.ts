/**
 * How far this device has read each conversation.
 *
 * ⚠️ **Separate from the poll cursor**, which `dm-session` already stores. The cursor tracks what has
 * been *fetched* and is advanced by the thread screen's poll; conflating the two would mark a
 * conversation read because the app happened to sync it. This marker moves only when a person is
 * looking at the thread.
 *
 * Stored in the clear, for the same reason as the cursor: it is a timestamp the server already knows,
 * and a corrupt value degrades to showing a dot rather than to a decrypt failure.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

const ORIGIN = 'dm-read'

const readKey = (convId: string): string => `@pnyx/dm/read/${convId}`

/**
 * Listeners for "a marker moved".
 *
 * ⚠️ Without this the dot outlives the reading. Unread is derived from markers, and the derivation
 * re-runs on session, socket-open and `dm-waiting` — none of which happen when someone simply reads
 * a thread and navigates back, so the conversation stayed lit until the next message arrived.
 */
const listeners = new Set<() => void>()

/** Notified whenever a read marker is written. Returns an unsubscribe. */
export const onReadMarkersChanged = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Record that the conversation is read up to `at` (ISO-8601). */
export const markConversationRead = async (convId: string, at: string): Promise<void> => {
  try {
    await storage.set(readKey(convId), at)
    // A silent success here is indistinguishable from a marker that was never written, which is
    // exactly the shape of the bug this whole trail is about.
    logger.debug('conversation marked read', {origin: ORIGIN, convId, at})
    for (const listener of listeners) listener()
  } catch (error) {
    // The dot stays lit, which is the safe direction: the user sees an unread conversation they have
    // in fact read, rather than a read one hiding a message.
    logger.warn('could not record a conversation as read', {origin: ORIGIN, convId, error: String(error)})
  }
}

/** Read markers for these conversations. A conversation with no marker is absent from the map. */
export const loadReadMarkers = async (convIds: readonly string[]): Promise<ReadonlyMap<string, string>> => {
  const out = new Map<string, string>()
  for (const convId of convIds) {
    try {
      const stored = await storage.get(readKey(convId))
      if (stored !== null && stored.length > 0) out.set(convId, stored)
    } catch (error) {
      // Absent, so the conversation reads as unread — see the module note on which way to fail.
      logger.warn('could not read a conversation read-marker', {origin: ORIGIN, convId, error: String(error)})
    }
  }
  return out
}
