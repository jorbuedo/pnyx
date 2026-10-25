/**
 * The conversation list, as the device knows it.
 *
 * ⚠️ **The server does not have a conversations table**, and after delivered ciphertext starts being
 * deleted it will not be able to fake one either: `listDmConversations` is a `GROUP BY conv_id` over
 * `dm_messages`, so a conversation exists there only while it still has undelivered messages. That
 * projection is therefore reinterpreted — it is *what is waiting*, not *who you talk to* — and this
 * index owns identity, the peer, and ordering.
 *
 * Pure, so the merge rule is testable without storage or a socket. The rule that matters is which
 * `lastMessageAt` wins, because unread is derived from it: **the newer of the two always wins**, or a
 * conversation whose message is still sitting undelivered on the server would read as up to date the
 * moment the local index was written.
 *
 * @module
 */

/** One conversation, as the inbox renders it. */
export type DmConversation = {
  readonly convId: string
  /** The peer's `pnyx_id`. Never resolved from a server field — see `dm-api`. */
  readonly peer: string
  /** ISO-8601 of the newest message either side knows about. */
  readonly lastMessageAt: string
}

/** Newest first, then by id so the order is total and a re-render cannot reshuffle equal rows. */
const byRecency = (a: DmConversation, b: DmConversation): number =>
  b.lastMessageAt.localeCompare(a.lastMessageAt) || a.convId.localeCompare(b.convId)

export const sortConversations = (list: readonly DmConversation[]): readonly DmConversation[] =>
  [...list].sort(byRecency)

/**
 * Add or update one conversation.
 *
 * `lastMessageAt` only ever moves forward: a late-arriving write about an older message must not
 * drag the marker back and re-light a dot the user already cleared. A peer is only overwritten by a
 * non-empty value, so a `touch` that knows the id but not the peer cannot blank it.
 */
export const upsertConversation = (
  list: readonly DmConversation[],
  entry: DmConversation,
): readonly DmConversation[] => {
  const existing = list.find((one) => one.convId === entry.convId)
  if (existing === undefined) return sortConversations([...list, entry])
  const merged: DmConversation = {
    convId: existing.convId,
    peer: entry.peer !== '' ? entry.peer : existing.peer,
    lastMessageAt:
      entry.lastMessageAt.localeCompare(existing.lastMessageAt) > 0 ? entry.lastMessageAt : existing.lastMessageAt,
  }
  return sortConversations(list.map((one) => (one.convId === entry.convId ? merged : one)))
}

/**
 * Fold what the server still holds into what this device knows.
 *
 * Server rows contribute two things and nothing else: proof that something is **waiting** (a newer
 * `lastMessageAt`), and a peer for a conversation this device has never heard of — which is what a
 * restored or reinstalled device sees before it has an index of its own.
 */
/**
 * Drop one conversation from the index.
 *
 * ⚠️ A removal the *server* can undo: `mergeServerPending` adds back anything still undelivered, so
 * deleting a conversation whose messages are still queued will re-list it on the next merge. That is
 * correct — the row exists because something is genuinely waiting — but it means deletion is only
 * final once the queue is empty.
 */
export const removeConversation = (list: readonly DmConversation[], convId: string): readonly DmConversation[] =>
  list.filter((one) => one.convId !== convId)

export const mergeServerPending = (
  local: readonly DmConversation[],
  pending: readonly DmConversation[],
): readonly DmConversation[] => pending.reduce(upsertConversation, local)

/** Conversations with something newer than this device has read. `markers` is convId → ISO-8601. */
export const unreadConvIds = (
  list: readonly DmConversation[],
  markers: ReadonlyMap<string, string>,
): readonly string[] =>
  list
    .filter((one) => {
      const marker = markers.get(one.convId)
      // Never read at all still counts as unread — otherwise a conversation you have never opened is
      // indistinguishable from one you have finished with.
      return marker === undefined || one.lastMessageAt.localeCompare(marker) > 0
    })
    .map((one) => one.convId)
