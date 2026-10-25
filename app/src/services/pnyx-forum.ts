/**
 * Pure view-model helpers for the Discord-shaped forum screens.
 * No React / React Native imports — unit-testable directly.
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {logger} from '../logger'
import {type ChainRef, type CircleView, PnyxApiError, type Post, type Proposal} from './pnyx-api'

export type ForumErrorKey =
  | 'forum.errors.generic'
  | 'forum.errors.network'
  | 'forum.errors.authRequired'
  | 'forum.errors.membersOnly'
  | 'forum.errors.alreadyJoined'
  | 'forum.errors.nameTaken'

/**
 * Maps a content-service failure onto a translation key. Service error bodies
 * speak the API's circle/persona vocabulary, so they are never shown raw —
 * every user-visible error goes through this mapping.
 */
export const forumErrorKey = (error: unknown): ForumErrorKey => {
  if (error instanceof PnyxApiError) {
    if (error.isNetworkError) return 'forum.errors.network'
    if (error.status === 401) return 'forum.errors.authRequired'
    if (error.status === 403) return 'forum.errors.membersOnly'
    if (error.status === 409) {
      // The service's two join conflicts: display name taken vs already joined.
      return error.message.includes('taken') ? 'forum.errors.nameTaken' : 'forum.errors.alreadyJoined'
    }
  }
  return 'forum.errors.generic'
}

export type ChatMessage = {
  readonly post: Post
  /** Direct parent when this post is a reply and the parent is in the fetch. */
  readonly replyTo: Post | undefined
}

/**
 * Flattens a community's discussion stream into a Discord-style chat timeline:
 * messages keep server order (createdAt), and a reply carries its direct
 * parent for the reply-reference line — one reference level regardless of
 * thread depth. Replies whose parent is missing from the list render as plain
 * messages so a partial fetch never drops context silently.
 */
export const buildChatTimeline = (posts: readonly Post[]): readonly ChatMessage[] => {
  const byId = new Map(posts.map((post) => [post.id, post]))
  return posts.map((post) => ({
    post,
    replyTo: post.parentId === undefined ? undefined : byId.get(post.parentId),
  }))
}

const isPending = (chain: ChainRef | null | undefined): boolean => chain?.status === 'pending'

/**
 * True while any chain mirror in the view is still pending — drives the 5s
 * badge-flip polling.
 */
export const hasPendingChain = (view: CircleView | undefined): boolean => {
  if (view === undefined) return false
  return (
    isPending(view.circle.chain) ||
    isPending(view.membership?.chain) ||
    view.proposals.some((proposal) => isPending(proposal.chain) || isPending(proposal.myVoteChain))
  )
}

/** Share of yes votes in [0, 1]; 0 when nobody voted yet. */
export const yesShare = (tally: Proposal['tally']): number => {
  const total = tally.yes + tally.no
  return total === 0 ? 0 : tally.yes / total
}

/**
 * Display form of an author string. Disclosed members author under their full
 * `pnyx_id` — middle-truncate anything id-length so rows stay readable;
 * chosen display names pass through untouched.
 */
export const formatAuthor = (author: string, max = 24): string => {
  if (author.length <= max) return author
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${author.slice(0, head)}…${author.slice(author.length - tail)}`
}

/**
 * The author's Pnyx id, or `null` when they posted under a pseudonym.
 *
 * An author string is *either* a disclosed `pnyx_id` (the server writes the subject
 * itself as the persona — `services/content/src/routes.ts` `personaChoice`, and the
 * subject is `C`) *or* a chosen display name. The subject behind a pseudonym is never
 * sent to clients, so for those there is genuinely no id and the answer is `null`
 * rather than a guess.
 *
 * **Decided by an actual bech32m decode, not a prefix test.** `decodePnyxId`
 * checks the HRP and that the payload is 32 bytes, so a display name that happens to
 * begin `pnyx_id` cannot pass. Anything id-shaped that fails to decode is a
 * pseudonym as far as callers are concerned — the point of this function is to gate
 * identity-revealing actions, so it must not be optimistic.
 */
export const authorIdentity = (author: string): string | null => {
  try {
    decodePnyxId(author)
    return author
  } catch (e: unknown) {
    // `null` means "this author string is not an identity", which is the ordinary case for a
    // persona label — the decode throwing is the test.
    logger.debug('Author string is not a pnyx_id', {origin: 'pnyx-forum', error: String(e)})
    return null
  }
}

// A disclosed author is a `C`, and `services/peer-label.ts` turns one into the handle its row
// names. Callers that have not adopted it render {@link formatAuthor}, which is always correct.
