/**
 * Who this device has seen posting in a circle, newest first.
 *
 * The merge rule for {@link module:./circle-peers}, kept pure so it can be tested without a store.
 *
 * ⚠️ **This is a record of people, not of posts.** One entry per identity, carrying only when they
 * were last seen and where — never what they said. A circle's discussion is fetched fresh every time
 * it is opened; nothing here is a cache of it, and nothing here is needed to render one.
 *
 * ⚠️ **Pseudonymous authors never reach it.** A post authored under a per-circle persona is not a
 * `pnyx_id` and cannot be messaged, so `authorIdentity` returns `null` for one and the caller drops
 * it. Storing them would build a list of people the user cannot act on out of exactly the identities
 * the persona exists to keep separate.
 *
 * @module
 */

/** One person, and the last time this device saw them post. */
export type CirclePeer = {
  /** Their disclosed `pnyx_id`. */
  readonly pnyxId: string
  /** The circle they were most recently seen in, for the row's subtitle. */
  readonly circleId: string
  /** The circle's display name at that moment — stored so the list needs no second fetch to label. */
  readonly circleName: string
  /** Epoch millis of the newest post of theirs this device has seen. */
  readonly lastSeenAt: number
}

/**
 * How many people the list keeps.
 *
 * A bound rather than a preference: this is a local record of a social graph, and one that only ever
 * grows is one that eventually describes every circle the user has ever opened. Fifty is far more
 * than a "start a conversation" shortcut can show, and the oldest are exactly the least useful.
 */
export const MAX_CIRCLE_PEERS = 50

/**
 * Fold newly-seen people into the stored list, newest first.
 *
 * Monotonic in `lastSeenAt`: a re-read of an older post cannot move somebody up the list, and cannot
 * relabel which circle they were most recently seen in. That is what makes the caller's "record what
 * this view showed" safe to run on every fetch, including a refetch of a stale view.
 */
export const mergeCirclePeers = (
  current: readonly CirclePeer[],
  seen: readonly CirclePeer[],
): readonly CirclePeer[] => {
  const byId = new Map(current.map((peer) => [peer.pnyxId, peer]))
  for (const peer of seen) {
    const held = byId.get(peer.pnyxId)
    if (held !== undefined && held.lastSeenAt >= peer.lastSeenAt) continue
    byId.set(peer.pnyxId, peer)
  }
  return [...byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_CIRCLE_PEERS)
}

/**
 * The people worth offering as a shortcut: everyone seen, less yourself.
 *
 * ⚠️ Yourself is excluded here rather than at write time, because "who has posted in this circle" is
 * a fact about the circle and stays true; whose device is reading it is not. Filtering on the way in
 * would bake the reader into the record.
 */
export const suggestedCirclePeers = (
  peers: readonly CirclePeer[],
  selfIdentity: string | undefined,
): readonly CirclePeer[] => peers.filter((peer) => peer.pnyxId !== selfIdentity)
