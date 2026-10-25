/**
 * People seen posting in circles, remembered locally so starting a conversation does not begin with
 * copying an id.
 *
 * ⚠️ **Written from what a screen already fetched, never from a fetch of its own.** A circle view is
 * loaded to be *read*; this only notices who was in it. So there is no request budget attached to the
 * suggestions, they are as fresh as the last circle the user opened, and they work offline — the
 * record is on the device, sealed under the same `forumRoot` key as the conversation index.
 *
 * ⚠️ **Writes are best-effort and never block what they follow.** Remembering who posted is
 * bookkeeping; reading the circle is the product. A failed write costs a suggestion, so it is logged
 * and swallowed — logged because a record that silently stopped growing looks exactly like a user who
 * has been in no circles.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {type CirclePeer, mergeCirclePeers} from './circle-peer-index'
import {deriveDmStoreKey, loadCirclePeers, saveCirclePeers} from './dm-session'
import type {Circle, Post} from './pnyx-api'
import {authorIdentity} from './pnyx-forum'

const ORIGIN = 'circle-peers'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

/**
 * The disclosed authors of a circle's posts, newest sighting per person.
 *
 * Pure, so the "who was in this view" rule is testable without a store. A post authored under a
 * per-circle persona yields no identity and is skipped — see `circle-peer-index.ts`.
 *
 * ⚠️ **An unparseable `createdAt` is skipped, not dated `0` or `now`.** Zero would bury a real person
 * at the bottom of the list for ever; `now` would promote them above people genuinely seen later. A
 * sighting with no usable time is a sighting we cannot order, and the list is an ordering.
 */
export const circlePeersInView = (circle: Circle, posts: readonly Post[]): readonly CirclePeer[] => {
  const seen: CirclePeer[] = []
  for (const post of posts) {
    const pnyxId = authorIdentity(post.author)
    if (pnyxId === null) continue
    const lastSeenAt = Date.parse(post.createdAt)
    if (Number.isNaN(lastSeenAt)) {
      logger.debug('a post with an unreadable timestamp cannot be ordered; not recording its author', {
        origin: ORIGIN,
        createdAt: post.createdAt,
      })
      continue
    }
    seen.push({pnyxId, circleId: circle.id, circleName: circle.name, lastSeenAt})
  }
  return seen
}

/** Fold the people in a freshly-read circle view into the local record. */
export const rememberCirclePeers = async (
  forumRoot: Uint8Array,
  circle: Circle,
  posts: readonly Post[],
): Promise<void> => {
  const seen = circlePeersInView(circle, posts)
  if (seen.length === 0) return
  try {
    const storeKey = await run(deriveDmStoreKey(forumRoot))
    const current = await run(loadCirclePeers(storeKey))
    const next = mergeCirclePeers(current, seen)
    // Monotonic, so an unchanged head means nothing moved — skipping the write keeps a refetch of the
    // same circle from resealing an identical blob on every socket signal.
    if (next.length === current.length && next[0]?.pnyxId === current[0]?.pnyxId) {
      if (next[0]?.lastSeenAt === current[0]?.lastSeenAt) return
    }
    await run(saveCirclePeers(storeKey, next))
    logger.debug('recorded the people seen in a circle', {origin: ORIGIN, circleId: circle.id, size: next.length})
  } catch (error) {
    logger.warn('could not record the people seen in a circle; the suggestions stay as they were', {
      origin: ORIGIN,
      circleId: circle.id,
      error: String(error),
    })
  }
}

/**
 * Everyone this device has seen in a circle, newest first.
 *
 * A corrupt record reads as empty *after saying so*: the alternative is letting it throw and taking
 * down a screen whose actual job — starting a conversation with a typed id — needs none of this.
 */
export const listCirclePeers = async (forumRoot: Uint8Array): Promise<readonly CirclePeer[]> => {
  try {
    const storeKey = await run(deriveDmStoreKey(forumRoot))
    return await run(loadCirclePeers(storeKey))
  } catch (error) {
    logger.warn('the record of people seen in circles is unreadable; offering no suggestions', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
}
