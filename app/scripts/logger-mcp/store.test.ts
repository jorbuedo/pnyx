import {describe, expect, it} from 'vitest'

import {createLogStore, type LogEntry} from './store'

const entry = (override: Partial<LogEntry> = {}): LogEntry => ({
  source: 'app',
  level: 'info',
  message: 'hello',
  metadata: {},
  timestamp: 1_700_000_000_000,
  ...override,
})

describe('createLogStore', () => {
  it('retains entries up to the cap, evicting oldest first', () => {
    const store = createLogStore(3)
    store.push(entry({timestamp: 1, message: 'a'}))
    store.push(entry({timestamp: 2, message: 'b'}))
    store.push(entry({timestamp: 3, message: 'c'}))
    store.push(entry({timestamp: 4, message: 'd'}))
    expect(store.read().map((e) => e.message)).toEqual(['b', 'c', 'd'])
  })

  it('returns most recent entries up to limit, oldest-first within result', () => {
    const store = createLogStore()
    for (let i = 0; i < 5; i += 1) store.push(entry({timestamp: i, message: `m${i}`}))
    expect(store.read({limit: 3}).map((e) => e.message)).toEqual(['m2', 'm3', 'm4'])
  })

  it('filters by since / until inclusive', () => {
    const store = createLogStore()
    for (let i = 0; i < 5; i += 1) store.push(entry({timestamp: i, message: `m${i}`}))
    expect(store.read({since: 2}).map((e) => e.message)).toEqual(['m2', 'm3', 'm4'])
    expect(store.read({until: 2}).map((e) => e.message)).toEqual(['m0', 'm1', 'm2'])
    expect(store.read({since: 1, until: 3}).map((e) => e.message)).toEqual(['m1', 'm2', 'm3'])
  })

  it('filters by level (single and comma list)', () => {
    const store = createLogStore()
    store.push(entry({level: 'debug', message: 'd'}))
    store.push(entry({level: 'info', message: 'i'}))
    store.push(entry({level: 'warn', message: 'w'}))
    store.push(entry({level: 'error', message: 'e'}))
    expect(store.read({level: 'warn'}).map((e) => e.message)).toEqual(['w'])
    expect(store.read({level: 'warn,error'}).map((e) => e.message)).toEqual(['w', 'e'])
  })

  it('filters by source', () => {
    const store = createLogStore()
    store.push(entry({source: 'app', message: 'a'}))
    store.push(entry({source: 'extension-bg', message: 'b'}))
    expect(store.read({source: 'extension-bg'}).map((e) => e.message)).toEqual(['b'])
  })

  it('filters by metadata.origin prefix', () => {
    const store = createLogStore()
    store.push(entry({metadata: {origin: 'perf:render'}, message: 'r'}))
    store.push(entry({metadata: {origin: 'perf:idle'}, message: 'i'}))
    store.push(entry({metadata: {origin: 'http:request'}, message: 'h'}))
    expect(store.read({originPrefix: 'perf:'}).map((e) => e.message)).toEqual(['r', 'i'])
  })

  it('filters by message substring', () => {
    const store = createLogStore()
    store.push(entry({message: 'wallet ready'}))
    store.push(entry({message: 'swap submitted'}))
    expect(store.read({messageSubstr: 'wallet'}).map((e) => e.message)).toEqual(['wallet ready'])
  })

  it('clear empties the buffer', () => {
    const store = createLogStore()
    store.push(entry())
    store.push(entry())
    store.clear()
    expect(store.read()).toEqual([])
    expect(store.summary().total).toBe(0)
  })

  it('summary reports counts, top origins, and time range', () => {
    const store = createLogStore()
    store.push(entry({timestamp: 100, level: 'info', source: 'app', metadata: {origin: 'perf:a'}}))
    store.push(entry({timestamp: 200, level: 'warn', source: 'app', metadata: {origin: 'perf:a'}}))
    store.push(entry({timestamp: 300, level: 'info', source: 'extension-bg', metadata: {origin: 'http:req'}}))
    const s = store.summary()
    expect(s.total).toBe(3)
    expect(s.byLevel).toEqual({info: 2, warn: 1})
    expect(s.bySource).toEqual({app: 2, 'extension-bg': 1})
    expect(s.topOrigins[0]).toEqual({origin: 'perf:a', count: 2})
    expect(s.timeRange).toEqual({first: 100, last: 300})
  })

  it('summary handles an empty buffer', () => {
    const store = createLogStore()
    expect(store.summary()).toEqual({total: 0, byLevel: {}, bySource: {}, topOrigins: [], timeRange: null})
  })

  it('pushBatch ingests an array of entries', () => {
    const store = createLogStore()
    store.pushBatch([entry({message: 'a'}), entry({message: 'b'})])
    expect(store.read().map((e) => e.message)).toEqual(['a', 'b'])
  })
})
