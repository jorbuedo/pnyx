import {describe, expect, it} from 'vitest'

import {ACTIVITY_CAP, type AgentCall, appendCall, callLabel, callsPerMinute, rateIsCapped} from './activity'

const call = (over: Partial<AgentCall> = {}): AgentCall => ({
  at: 1_000_000,
  method: 'tools/call',
  agent: 'claude',
  outcome: 'ok',
  ms: 12,
  ...over,
})

describe('appendCall', () => {
  it('puts the newest first', () => {
    const tail = appendCall(appendCall([], call({at: 1})), call({at: 2}))
    expect(tail.map((c) => c.at)).toEqual([2, 1])
  })

  it('drops the oldest past the cap', () => {
    let tail: readonly AgentCall[] = []
    for (let i = 0; i < ACTIVITY_CAP + 10; i++) tail = appendCall(tail, call({at: i}))
    expect(tail).toHaveLength(ACTIVITY_CAP)
    expect(tail[0]?.at).toBe(ACTIVITY_CAP + 9)
    expect(tail[tail.length - 1]?.at).toBe(10)
  })

  it('does not mutate the array it was given', () => {
    const original: readonly AgentCall[] = [call({at: 1})]
    appendCall(original, call({at: 2}))
    expect(original).toHaveLength(1)
  })

  it('honours a cap of one', () => {
    const tail = appendCall(appendCall([], call({at: 1}), 1), call({at: 2}), 1)
    expect(tail.map((c) => c.at)).toEqual([2])
  })
})

describe('callsPerMinute', () => {
  it('counts only what is inside the window', () => {
    const now = 1_000_000
    const tail = [call({at: now - 1_000}), call({at: now - 59_999}), call({at: now - 60_001})]
    expect(callsPerMinute(tail, now)).toBe(2)
  })

  it('falls to zero once the window has passed', () => {
    const tail = [call({at: 1_000})]
    expect(callsPerMinute(tail, 1_000)).toBe(1)
    expect(callsPerMinute(tail, 1_000 + 60_001)).toBe(0)
  })

  it('is zero for an empty tail', () => {
    expect(callsPerMinute([], 1)).toBe(0)
  })
})

describe('rateIsCapped', () => {
  // The figure is a floor, not a reading, once the tail is full of one minute's calls — saying so is
  // the difference between "50/min" and "at least 50/min", and only the second is true.
  it('is true when a full tail all falls inside the window', () => {
    const now = 1_000_000
    const tail = Array.from({length: ACTIVITY_CAP}, (_, i) => call({at: now - i}))
    expect(rateIsCapped(tail, now)).toBe(true)
  })

  it('is false when the tail is full but spread beyond the window', () => {
    const now = 1_000_000
    const tail = Array.from({length: ACTIVITY_CAP}, (_, i) => call({at: now - i * 10_000}))
    expect(rateIsCapped(tail, now)).toBe(false)
  })

  it('is false for a tail that is not full', () => {
    const now = 1_000_000
    expect(rateIsCapped([call({at: now})], now)).toBe(false)
  })
})

describe('callLabel', () => {
  it('names the tool for a tools/call', () => {
    expect(callLabel(call({tool: 'cardano_readBalance'}))).toBe('cardano_readBalance')
  })

  it('names the method for anything else', () => {
    expect(callLabel(call({method: 'resources/read'}))).toBe('resources/read')
  })
})
