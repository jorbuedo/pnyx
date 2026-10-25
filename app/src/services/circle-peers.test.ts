import {describe, expect, it, vi} from 'vitest'
import type {Circle, Post} from './pnyx-api'

vi.mock('../logger', () => ({logger: {debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn()}}))

const {circlePeersInView} = await import('./circle-peers')

// A real 32-byte identity through `encodePnyxId`, so `authorIdentity` accepts it as disclosed.
const DISCLOSED = 'pnyx_id1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hwqk8jmw3'

const circle: Circle = {
  id: 'c1',
  name: 'Circle One',
  description: '',
  author: DISCLOSED,
  createdAt: '2026-09-01T00:00:00.000Z',
  memberCount: 2,
  isOpen: true,
}

const post = (author: string, createdAt: string): Post => ({
  id: `p-${author}-${createdAt}`,
  circleId: 'c1',
  body: 'hello',
  author,
  createdAt,
})

describe('circlePeersInView', () => {
  it('records a disclosed author with the circle they were seen in', () => {
    expect(circlePeersInView(circle, [post(DISCLOSED, '2026-09-01T10:00:00.000Z')])).toEqual([
      {
        pnyxId: DISCLOSED,
        circleId: 'c1',
        circleName: 'Circle One',
        lastSeenAt: Date.parse('2026-09-01T10:00:00.000Z'),
      },
    ])
  })

  it('skips a pseudonymous author, who cannot be messaged', () => {
    // A per-circle persona is not a `pnyx_id`; suggesting one would offer a conversation that cannot
    // be opened, out of exactly the identity the persona keeps separate.
    expect(circlePeersInView(circle, [post('bright-heron-42', '2026-09-01T10:00:00.000Z')])).toEqual([])
  })

  it('skips a post whose timestamp cannot be read, rather than dating it', () => {
    // `0` would bury a real person for ever and `now` would promote them over people seen later —
    // both are an ordering invented from a missing value.
    expect(circlePeersInView(circle, [post(DISCLOSED, 'not a date')])).toEqual([])
  })

  it('returns one sighting per post, leaving the merge to fold them', () => {
    const seen = circlePeersInView(circle, [
      post(DISCLOSED, '2026-09-01T10:00:00.000Z'),
      post(DISCLOSED, '2026-09-01T11:00:00.000Z'),
    ])
    expect(seen).toHaveLength(2)
  })

  it('records nothing for a circle with no posts', () => {
    expect(circlePeersInView(circle, [])).toEqual([])
  })
})
