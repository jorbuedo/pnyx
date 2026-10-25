/**
 * Which conversations the DM inbox's scrolling list may repeat.
 *
 * ⚠️ **`notesThread` used to live here and is gone.** It chose between an offline scratchpad and a
 * signed-in self-conversation — a distinction that stopped meaning anything once a note to self
 * posted nothing and fetched nothing, and whose only lasting effect was that notes written signed
 * out vanished on sign-in. There is one notes thread now, and it needs no session.
 *
 * **Which conversations to list.** The self-conversation comes back from `GET /dm` like any other,
 * and it is exactly the thread the anchored row already offers. Listed as well, the same
 * conversation appears twice under the same name, and the two rows reach it by different routes —
 * so they can disagree about whether it exists yet.
 *
 * @module
 */

/**
 * The conversations the scrolling list may show — everything the anchored notes row does not
 * already offer.
 *
 * Generic over the summary so a field added to `DmConversationSummary` needs no change here; `peer`
 * is the only thing this decides on.
 */
export const listedConversations = <T extends {readonly peer: string}>(
  conversations: readonly T[],
  selfIdentity: string,
): readonly T[] => conversations.filter((conversation) => conversation.peer !== selfIdentity)

/**
 * The conversations matching a search query — by the peer's handle when one is known, and by their
 * `pnyx_id` always.
 *
 * ⚠️ **The id is searchable even when a handle is showing.** A row drawn as `alice` is still that id,
 * and someone pasting an id they were given must find it — so both are matched rather than whichever
 * one happens to be on screen. It also means a handle that has not resolved yet (offline, or a peer
 * seen for the first time) is still reachable by id instead of being unfindable.
 *
 * Both sides are folded to NFC + lower case before comparing: handles are drawn in the spelling their
 * owner chose and may be in any script, so a byte comparison would fail on a decomposed or
 * differently-cased query of the very name on screen.
 *
 * An empty or whitespace-only query matches everything — the list is unfiltered, not empty.
 */
export const searchedConversations = <T extends {readonly peer: string}>(
  conversations: readonly T[],
  query: string,
  handles: ReadonlyMap<string, string>,
): readonly T[] => {
  const needle = fold(query.trim())
  if (needle === '') return conversations
  return conversations.filter((conversation) => {
    const handle = handles.get(conversation.peer)
    return fold(conversation.peer).includes(needle) || (handle !== undefined && fold(handle).includes(needle))
  })
}

const fold = (value: string): string => value.normalize('NFC').toLowerCase()
