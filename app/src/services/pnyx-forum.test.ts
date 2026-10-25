import {encodePnyxId} from '@pnyx/contract-client/identity'
import {encodeNightAddress} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {type ChainRef, type CircleView, PnyxApiError, type Post} from './pnyx-api'
import {authorIdentity, buildChatTimeline, formatAuthor, forumErrorKey, hasPendingChain, yesShare} from './pnyx-forum'

const post = (id: string, parentId?: string): Post => ({
  id,
  circleId: 'c1',
  ...(parentId === undefined ? {} : {parentId}),
  body: `body ${id}`,
  author: 'owl',
  createdAt: `2026-07-05T00:00:0${id.length}Z`,
})

const view = (overrides: Partial<CircleView> = {}): CircleView => ({
  circle: {id: 'c1', name: 'T', description: '', author: 'a', createdAt: 'now', memberCount: 1, isOpen: true},
  membership: null,
  proposals: [],
  posts: [],
  ...overrides,
})

const chain = (status: ChainRef['status']): ChainRef => ({status})

describe('buildChatTimeline', () => {
  it('keeps server order and resolves each reply to its direct parent', () => {
    const posts = [post('a'), post('b'), post('a1', 'a'), post('a2', 'a'), post('a1x', 'a1')]

    const timeline = buildChatTimeline(posts)

    expect(timeline.map((m) => m.post.id)).toEqual(['a', 'b', 'a1', 'a2', 'a1x'])
    expect(timeline.map((m) => m.replyTo?.id)).toEqual([undefined, undefined, 'a', 'a', 'a1'])
  })

  it('caps the reference at one level — a nested reply references its direct parent, not the root', () => {
    const timeline = buildChatTimeline([post('a'), post('a1', 'a'), post('a1x', 'a1')])
    expect(timeline[2]?.replyTo?.id).toBe('a1')
  })

  it('renders replies with a missing parent as plain messages instead of dropping them', () => {
    const timeline = buildChatTimeline([post('a'), post('z', 'missing-parent')])
    expect(timeline.map((m) => m.post.id)).toEqual(['a', 'z'])
    expect(timeline[1]?.replyTo).toBeUndefined()
  })

  it('returns an empty timeline for no posts', () => {
    expect(buildChatTimeline([])).toEqual([])
  })
})

describe('hasPendingChain', () => {
  it('is false for undefined views and fully confirmed views', () => {
    expect(hasPendingChain(undefined)).toBe(false)
    expect(hasPendingChain(view({circle: {...view().circle, chain: chain('confirmed')}}))).toBe(false)
  })

  it('detects pending circle, membership, proposal, and vote mirrors', () => {
    expect(hasPendingChain(view({circle: {...view().circle, chain: chain('pending')}}))).toBe(true)
    expect(
      hasPendingChain(view({membership: {persona: 'owl', disclosed: false, joinedAt: 'now', chain: chain('pending')}})),
    ).toBe(true)
    const proposal = {
      id: 'p1',
      circleId: 'c1',
      title: 't',
      body: '',
      author: 'owl',
      createdAt: 'now',
      tally: {yes: 0, no: 0},
    }
    expect(hasPendingChain(view({proposals: [{...proposal, chain: chain('pending')}]}))).toBe(true)
    expect(
      hasPendingChain(view({proposals: [{...proposal, chain: chain('confirmed'), myVoteChain: chain('pending')}]})),
    ).toBe(true)
    expect(hasPendingChain(view({proposals: [{...proposal, chain: chain('failed')}]}))).toBe(false)
  })
})

describe('yesShare', () => {
  it('is 0 when nobody voted', () => {
    expect(yesShare({yes: 0, no: 0})).toBe(0)
  })

  it('is the yes fraction otherwise', () => {
    expect(yesShare({yes: 3, no: 1})).toBe(0.75)
    expect(yesShare({yes: 0, no: 2})).toBe(0)
    expect(yesShare({yes: 2, no: 0})).toBe(1)
  })
})

describe('forumErrorKey', () => {
  it('maps network failures to the network key', () => {
    expect(forumErrorKey(new PnyxApiError(undefined, 'unreachable'))).toBe('forum.errors.network')
  })

  it('maps auth and membership gates', () => {
    expect(forumErrorKey(new PnyxApiError(401, 'authentication required'))).toBe('forum.errors.authRequired')
    expect(forumErrorKey(new PnyxApiError(403, 'join the circle to post'))).toBe('forum.errors.membersOnly')
  })

  it('distinguishes the two join conflicts', () => {
    expect(forumErrorKey(new PnyxApiError(409, 'that persona name is taken in this circle'))).toBe(
      'forum.errors.nameTaken',
    )
    expect(forumErrorKey(new PnyxApiError(409, 'already a member of this circle'))).toBe('forum.errors.alreadyJoined')
  })

  it('never leaks raw service vocabulary — unknown errors map to generic', () => {
    expect(forumErrorKey(new PnyxApiError(500, 'circle exploded'))).toBe('forum.errors.generic')
    expect(forumErrorKey(new Error('boom'))).toBe('forum.errors.generic')
    expect(forumErrorKey(undefined)).toBe('forum.errors.generic')
  })
})

describe('formatAuthor', () => {
  it('passes short display names through', () => {
    expect(formatAuthor('night-owl')).toBe('night-owl')
  })

  it('middle-truncates address-length authors to the requested budget', () => {
    const address = `mn_addr_test1${'q'.repeat(50)}`
    const formatted = formatAuthor(address)
    expect(formatted.length).toBe(24)
    expect(formatted).toContain('…')
    expect(formatted.startsWith('mn_addr_test')).toBe(true)
    expect(formatted.endsWith('q')).toBe(true)
  })
})

describe('authorIdentity', () => {
  const DISCLOSED = encodePnyxId(new Uint8Array(32).fill(0x2b))

  it('returns the id for a disclosed author', () => {
    expect(authorIdentity(DISCLOSED)).toBe(DISCLOSED)
  })

  it('returns null for a chosen display name', () => {
    expect(authorIdentity('night-owl')).toBeNull()
    expect(authorIdentity('Jordi')).toBeNull()
  })

  // The whole point: this gates an identity-revealing action, so a pseudonym that merely *looks*
  // like an id must not pass. A prefix test would let all of these through.
  it('rejects id-shaped strings that are not valid ids', () => {
    for (const impostor of [
      'pnyx_id',
      'pnyx_id1',
      'pnyx_id_preprod1',
      'pnyx_id_preprod1notvalidbech32m!!!',
      // right shape, wrong checksum (last char flipped)
      `${DISCLOSED.slice(0, -1)}x`,
      // valid bech32m but the wrong HRP entirely
      encodeNightAddress(new Uint8Array(32).fill(3), 'preprod'),
    ]) {
      expect(authorIdentity(impostor)).toBeNull()
    }
  })

  it('rejects empty and whitespace authors', () => {
    expect(authorIdentity('')).toBeNull()
    expect(authorIdentity('   ')).toBeNull()
  })
})
