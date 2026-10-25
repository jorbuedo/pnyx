import {describe, expect, it} from 'vitest'
import {type CirclePeer, MAX_CIRCLE_PEERS, mergeCirclePeers, suggestedCirclePeers} from './circle-peer-index'

const peer = (pnyxId: string, lastSeenAt: number, circleId = 'c1', circleName = 'Circle One'): CirclePeer => ({
  pnyxId,
  circleId,
  circleName,
  lastSeenAt,
})

describe('mergeCirclePeers', () => {
  it('keeps one entry per person, newest first', () => {
    const merged = mergeCirclePeers([peer('a', 100)], [peer('b', 300), peer('c', 200)])
    expect(merged.map((one) => one.pnyxId)).toEqual(['b', 'c', 'a'])
  })

  it('moves someone up when they are seen more recently', () => {
    const merged = mergeCirclePeers([peer('a', 100), peer('b', 200)], [peer('a', 300)])
    expect(merged.map((one) => one.pnyxId)).toEqual(['a', 'b'])
    expect(merged[0]?.lastSeenAt).toBe(300)
  })

  it('ignores an older sighting of somebody already recorded', () => {
    // A refetch of a stale view must not drag a person backwards, or reopening an old circle would
    // reorder the list by what was read last rather than by what happened last.
    const merged = mergeCirclePeers([peer('a', 300, 'c2', 'Circle Two')], [peer('a', 100)])
    expect(merged).toEqual([peer('a', 300, 'c2', 'Circle Two')])
  })

  it('relabels the circle only when the sighting is newer', () => {
    const merged = mergeCirclePeers([peer('a', 100, 'c1', 'Circle One')], [peer('a', 200, 'c2', 'Circle Two')])
    expect(merged[0]?.circleName).toBe('Circle Two')
  })

  it('caps the list, dropping the least recently seen', () => {
    const many = Array.from({length: MAX_CIRCLE_PEERS + 10}, (_, i) => peer(`p${i}`, i))
    const merged = mergeCirclePeers([], many)
    expect(merged).toHaveLength(MAX_CIRCLE_PEERS)
    // The highest `lastSeenAt` survive; `p0`..`p9` are the ten dropped.
    expect(merged.at(-1)?.pnyxId).toBe('p10')
    expect(merged.some((one) => one.pnyxId === 'p0')).toBe(false)
  })

  it('is unchanged by merging nothing', () => {
    const current = [peer('a', 100)]
    expect(mergeCirclePeers(current, [])).toEqual(current)
  })
})

describe('suggestedCirclePeers', () => {
  it('leaves you out of your own suggestions', () => {
    expect(suggestedCirclePeers([peer('me', 200), peer('them', 100)], 'me')).toEqual([peer('them', 100)])
  })

  it('suggests everyone when the reader is unknown', () => {
    // Not a reason to hide the list: with no identity there is no self to collide with.
    expect(suggestedCirclePeers([peer('them', 100)], undefined)).toEqual([peer('them', 100)])
  })
})
