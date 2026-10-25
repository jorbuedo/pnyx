/**
 * Which conversations have something the user has not seen.
 *
 * ⚠️ **Derived, never accumulated.** Unread is a comparison between what the server says about a
 * conversation (`lastMessageAt`) and a marker of what this device has read — so it cannot drift,
 * cannot double-count, and needs no event log to reconcile. That matters because the same arrival
 * can reach the app twice by two transports (the socket while open, a push while not) and a counter
 * incremented by each would be wrong in both directions.
 *
 * Timestamps are compared as ISO-8601 strings, which sort lexicographically when they are UTC and
 * fixed-width — the server's `createdAt` is both. A malformed or missing marker reads as "never
 * read", which shows a dot: over-reporting attention is recoverable, silently hiding a message is
 * not.
 *
 * @module
 */

export type ConversationTimes = {
  readonly convId: string
  /** ISO-8601, from the service's conversation list. */
  readonly lastMessageAt: string
}

/** Read markers by conversation id, as {@link module:./dm-read} stores them. */
export type ReadMarkers = ReadonlyMap<string, string>

/** Conversation ids with unread messages, in the order given. */
export const unreadConversations = (
  conversations: readonly ConversationTimes[],
  markers: ReadMarkers,
): readonly string[] =>
  conversations.filter(({convId, lastMessageAt}) => isUnread(lastMessageAt, markers.get(convId))).map((c) => c.convId)

/** Is this conversation unread? `undefined` marker means never opened on this device. */
export const isUnread = (lastMessageAt: string, marker: string | undefined): boolean =>
  marker === undefined || marker < lastMessageAt

/**
 * Which conversations advanced between two readings of the list.
 *
 * Used to decide whether to say anything out loud (a toast). A conversation that is merely still
 * unread is not news — it already has its dot — so only a moved timestamp counts, and a
 * conversation seen for the first time counts as arriving.
 */
export const newlyArrived = (
  previous: readonly ConversationTimes[] | undefined,
  next: readonly ConversationTimes[],
): readonly string[] => {
  // No previous reading at all is the app starting up: everything is "new", which would announce a
  // backlog the user never asked about. Nothing is news until we have something to compare against.
  if (previous === undefined) return []
  const before = new Map(previous.map((c) => [c.convId, c.lastMessageAt]))
  return next
    .filter(({convId, lastMessageAt}) => {
      const was = before.get(convId)
      return was === undefined || was < lastMessageAt
    })
    .map((c) => c.convId)
}
