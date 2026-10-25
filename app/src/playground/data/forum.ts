/**
 * Forum fixtures for the UI Playground.
 *
 * `Post` and `Proposal` are the content-service shapes the forum components
 * take directly, so they get one fixture here rather than an object literal per
 * showcase. Dates are fixed strings so successive reloads render identically.
 *
 * @module
 */

import type {Post, Proposal} from '../../services/pnyx-api'

const CIRCLE_ID = 'playground-circle-0'

export const fakePost: Post = {
  id: 'playground-post-0',
  circleId: CIRCLE_ID,
  body: 'Has anyone compared the fee impact of consolidating before a large send?',
  author: 'lyra',
  createdAt: '2026-08-01T09:14:00.000Z',
}

export const fakeReply: Post = {
  id: 'playground-post-1',
  circleId: CIRCLE_ID,
  parentId: fakePost.id,
  body: 'Yes — batching the consolidation into the send saved about 40% on my last one.',
  author: 'castor',
  createdAt: '2026-08-01T10:02:00.000Z',
}

/** An open proposal the viewer has not voted on. */
export const fakeOpenProposal: Proposal = {
  id: 'playground-proposal-0',
  circleId: CIRCLE_ID,
  title: 'Raise the treasury spend cap to 50,000 ADA',
  body: 'The current cap blocks the audit retainer. Raising it lets the working group commission the review without a second vote.',
  author: 'lyra',
  createdAt: '2026-07-28T12:00:00.000Z',
  tally: {yes: 128, no: 34},
  hasVoted: false,
}

/** The same proposal after voting, with the on-chain mirror confirmed. */
export const fakeVotedProposal: Proposal = {
  ...fakeOpenProposal,
  id: 'playground-proposal-1',
  title: 'Adopt the quarterly contributor report',
  tally: {yes: 91, no: 3},
  hasVoted: true,
  chain: {status: 'confirmed', txId: '3c9f1b2d5e8a47c60b1d9e2f8a4c7b03'},
  myVoteChain: {status: 'confirmed'},
}

/** A proposal whose chain mirror is still pending, for the ChainBadge branch. */
export const fakePendingProposal: Proposal = {
  ...fakeOpenProposal,
  id: 'playground-proposal-2',
  title: 'Fund the mobile accessibility pass',
  tally: {yes: 12, no: 1},
  chain: {status: 'pending'},
}

export const fakeCircleRef = {id: CIRCLE_ID, name: 'Treasury', isOpen: true} as const
