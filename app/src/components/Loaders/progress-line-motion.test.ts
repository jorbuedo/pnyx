import {describe, expect, it} from 'vitest'
import {SEGMENT_RATIO, segmentOffset, segmentWidth} from './progress-line-motion'

const TRACK = 400

describe('progress line motion', () => {
  it('starts fully off the left edge', () => {
    // Not 0: a segment that appeared at the left edge would pop rather than travel in.
    expect(segmentOffset(TRACK, 0)).toBe(-segmentWidth(TRACK))
  })

  it('ends fully off the right edge', () => {
    expect(segmentOffset(TRACK, 1)).toBe(TRACK)
  })

  it('travels monotonically across the track', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((p) => segmentOffset(TRACK, p))
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(new Set(steps).size).toBe(steps.length)
  })

  it('scales the segment with the track so it reads the same on any width', () => {
    expect(segmentWidth(TRACK)).toBe(TRACK * SEGMENT_RATIO)
    expect(segmentWidth(1000) / 1000).toBe(segmentWidth(320) / 320)
  })

  it('degenerates to nothing before the track is measured', () => {
    // First frame: onLayout has not fired. Both must be 0 so nothing is painted at a stray offset.
    expect(segmentWidth(0)).toBe(0)
    expect(segmentOffset(0, 0.5)).toBe(0)
  })
})
