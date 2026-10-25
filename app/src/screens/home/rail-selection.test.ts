import {beforeEach, describe, expect, it, vi} from 'vitest'

const backing = new Map<string, string>()
vi.mock('../../platform/storage', () => ({
  storage: {
    getSync: (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      backing.set(key, String(value))
    },
  },
}))

const {readRailSelection, selectedCircleId, writeRailSelection} = await import('./rail-selection')

const KEY = '@pnyx/selected_community'

beforeEach(() => {
  backing.clear()
})

describe('rail selection', () => {
  it('round-trips a circle', () => {
    writeRailSelection({kind: 'circle', id: 'abc-123'})
    expect(readRailSelection()).toEqual({kind: 'circle', id: 'abc-123'})
  })

  it('round-trips direct messages', () => {
    writeRailSelection({kind: 'dm'})
    expect(readRailSelection()).toEqual({kind: 'dm'})
  })

  it('round-trips discover', () => {
    writeRailSelection({kind: 'discover'})
    expect(readRailSelection()).toEqual({kind: 'discover'})
  })

  it('round-trips info', () => {
    writeRailSelection({kind: 'info'})
    expect(readRailSelection()).toEqual({kind: 'info'})
  })

  it('reads a value written before DMs existed as a circle', () => {
    // No migration: previously the key held a bare circle id, and it must keep meaning that.
    backing.set(KEY, '9f1c2b7a-0000-4000-8000-000000000000')
    expect(readRailSelection()).toEqual({kind: 'circle', id: '9f1c2b7a-0000-4000-8000-000000000000'})
  })

  it('treats an unset or empty value as no selection', () => {
    expect(readRailSelection()).toBeUndefined()
    backing.set(KEY, '')
    expect(readRailSelection()).toBeUndefined()
  })

  it('selectedCircleId hides the DM and discover cases from community callers', () => {
    expect(selectedCircleId({kind: 'discover'})).toBeUndefined()
    expect(selectedCircleId({kind: 'info'})).toBeUndefined()
    expect(selectedCircleId({kind: 'circle', id: 'x'})).toBe('x')
    expect(selectedCircleId({kind: 'dm'})).toBeUndefined()
    expect(selectedCircleId(undefined)).toBeUndefined()
  })
})
