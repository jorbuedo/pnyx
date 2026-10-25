import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  __cacheInspectForTests,
  beginCeremony,
  clearAllCeremonies,
  evictGroupCeremony,
  getCachedMaterial,
  getCachedObject,
  isCeremonyActive,
  setCachedMaterial,
  setCachedObject,
} from './ceremony-cache'

beforeEach(() => {
  vi.useFakeTimers()
  clearAllCeremonies()
})

afterEach(() => {
  vi.useRealTimers()
  clearAllCeremonies()
})

describe('ceremony-cache', () => {
  it('caches a value while a ceremony is open and returns it on read', () => {
    const ceremony = beginCeremony('group-1')
    setCachedMaterial('group-1', 'mnemonic', 'word1 word2 word3')

    expect(getCachedMaterial('group-1', 'mnemonic')).toBe('word1 word2 word3')
    ceremony.close()
  })

  it('refuses to cache when no ceremony is open', () => {
    setCachedMaterial('group-1', 'mnemonic', 'should-not-stick')
    expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
  })

  it('returns null for groups without a ceremony', () => {
    const ceremony = beginCeremony('group-1')
    setCachedMaterial('group-1', 'mnemonic', 'value')

    expect(getCachedMaterial('group-2', 'mnemonic')).toBeNull()
    ceremony.close()
  })

  it('keeps the value alive while a second ceremony references the same group', () => {
    const a = beginCeremony('group-1')
    const b = beginCeremony('group-1')
    setCachedMaterial('group-1', 'mnemonic', 'value')

    a.close()
    expect(getCachedMaterial('group-1', 'mnemonic')).toBe('value')

    b.close()
    // After every ceremony closes the value is still in the cache, but
    // not readable without a fresh ceremony — exercised below.
    expect(isCeremonyActive('group-1')).toBe(false)
  })

  it('close() is idempotent', () => {
    const ceremony = beginCeremony('group-1')
    setCachedMaterial('group-1', 'mnemonic', 'value')
    ceremony.close()
    ceremony.close()
    expect(isCeremonyActive('group-1')).toBe(false)
  })

  it('issues distinct ceremony ids', () => {
    const a = beginCeremony('group-1')
    const b = beginCeremony('group-1')
    expect(a.ceremonyId).not.toBe(b.ceremonyId)
    a.close()
    b.close()
  })

  describe('lifetime model — material dies with its ceremony', () => {
    it('an open ceremony survives arbitrary clock time — nothing is time-based', () => {
      // The user sits on a form for a long time. Eviction must never happen
      // under them mid-flow; the bound is the ceremony, not a clock.
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'longform-value')

      vi.advanceTimersByTime(60 * 60_000)

      expect(getCachedMaterial('group-1', 'mnemonic')).toBe('longform-value')
      expect(isCeremonyActive('group-1')).toBe(true)
      ceremony.close()
    })

    it('close() drops the material immediately — nothing survives the operation', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'value')
      ceremony.close()

      // No lingering entry at all: not merely unreadable, gone.
      expect(__cacheInspectForTests?.().groups.get('group-1')).toBeUndefined()
      expect(isCeremonyActive('group-1')).toBe(false)
    })

    it('a later ceremony starts cold, however soon it opens', () => {
      // This is the behaviour the removed 5-minute TTL provided, and the reason
      // it was removed: a second flow could reach the seed with no prompt, so a
      // user could be walked through several signatures on taps alone.
      const first = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'seed')
      first.close()

      vi.advanceTimersByTime(1)

      const second = beginCeremony('group-1')
      expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
      second.close()
    })

    it('a nested ceremony keeps the material until the outermost closes', () => {
      // One user intent that opens a ceremony inside another still costs one
      // authentication — that is what the cache is for.
      const outer = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'value')
      const inner = beginCeremony('group-1')

      inner.close()
      expect(getCachedMaterial('group-1', 'mnemonic')).toBe('value')

      outer.close()
      expect(__cacheInspectForTests?.().groups.get('group-1')).toBeUndefined()
    })

    it('clearAllCeremonies drops every cached value and every entry', () => {
      const a = beginCeremony('group-1')
      const b = beginCeremony('group-2')
      setCachedMaterial('group-1', 'mnemonic', 'a')
      setCachedMaterial('group-2', 'mnemonic', 'b')

      clearAllCeremonies()

      expect(__cacheInspectForTests?.().groups.get('group-1')).toBeUndefined()
      expect(__cacheInspectForTests?.().groups.get('group-2')).toBeUndefined()
      expect(isCeremonyActive('group-1')).toBe(false)
      expect(isCeremonyActive('group-2')).toBe(false)

      // Stale handles still close cleanly.
      a.close()
      b.close()
    })

    it('evictGroupCeremony drops one group mid-ceremony without touching siblings', () => {
      // Its remaining purpose: re-authenticate on every action even inside one
      // open ceremony (recovery signing does this per "Sign" press).
      const a = beginCeremony('group-1')
      const b = beginCeremony('group-2')
      setCachedMaterial('group-1', 'mnemonic', 'a')
      setCachedMaterial('group-2', 'mnemonic', 'b')

      evictGroupCeremony('group-1')

      expect(__cacheInspectForTests?.().groups.get('group-1')).toBeUndefined()
      expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
      // group-2 is untouched and still readable under its open ceremony.
      expect(getCachedMaterial('group-2', 'mnemonic')).toBe('b')

      a.close()
      b.close()
    })

    it('evictGroupCeremony on an unknown group is a no-op', () => {
      expect(() => evictGroupCeremony('never-seen')).not.toThrow()
    })
  })

  describe('inspector', () => {
    it('reports tokenCount, kinds and objectKeys', () => {
      const ceremony = beginCeremony('group-1')
      expect(__cacheInspectForTests?.().groups.get('group-1')).toEqual({
        tokenCount: 1,
        kinds: [],
        objectKeys: [],
      })

      setCachedMaterial('group-1', 'mnemonic', 'value')
      setCachedObject('group-1', 'evm-signer', {sign: () => 'sig'}, 'value')
      expect(__cacheInspectForTests?.().groups.get('group-1')).toEqual({
        tokenCount: 1,
        kinds: ['mnemonic'],
        objectKeys: ['evm-signer'],
      })

      // Closing leaves no entry to inspect — there is no post-close state.
      ceremony.close()
      expect(__cacheInspectForTests?.().groups.get('group-1')).toBeUndefined()
    })
  })

  describe('guard binding', () => {
    it('returns the value when the read guard matches the write guard', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words', 'pw-correct')

      expect(getCachedMaterial('group-1', 'mnemonic', 'pw-correct')).toBe('twelve words')
      ceremony.close()
    })

    it('misses when the read guard does not match — a wrong guard must not hit the cache', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words', 'pw-correct')

      expect(getCachedMaterial('group-1', 'mnemonic', 'pw-wrong')).toBeNull()
      ceremony.close()
    })

    it('misses when a guarded value is read without a guard', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words', 'pw-correct')

      expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
      ceremony.close()
    })

    it('misses when an unguarded (enclave) value is read with a guard', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words')

      expect(getCachedMaterial('group-1', 'mnemonic', 'pw-any')).toBeNull()
      ceremony.close()
    })

    it('overwriting with a new guard rebinds the slot (guard change mid-ceremony)', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words', 'pw-old')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words', 'pw-new')

      expect(getCachedMaterial('group-1', 'mnemonic', 'pw-old')).toBeNull()
      expect(getCachedMaterial('group-1', 'mnemonic', 'pw-new')).toBe('twelve words')
      ceremony.close()
    })
  })

  describe('derived-object slots', () => {
    it('stores and returns an object while a ceremony is open, gated by guard', () => {
      const signer = {sign: () => 'sig'}
      const ceremony = beginCeremony('group-1')
      setCachedObject('group-1', 'evm-signer', signer, 'mnemonic words')

      expect(getCachedObject('group-1', 'evm-signer', 'mnemonic words')).toBe(signer)
      expect(getCachedObject('group-1', 'evm-signer', 'other words')).toBeNull()
      expect(getCachedObject('group-1', 'evm-signer')).toBeNull()
      ceremony.close()
    })

    it('refuses writes and reads without an active ceremony', () => {
      setCachedObject('group-1', 'evm-signer', {a: 1}, 'guard')
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBeNull()

      const ceremony = beginCeremony('group-1')
      setCachedObject('group-1', 'evm-signer', {a: 1}, 'guard')
      ceremony.close()
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBeNull()
    })

    it('drops objects together with the entry on close', () => {
      const ceremony = beginCeremony('group-1')
      setCachedObject('group-1', 'evm-signer', {a: 1}, 'guard')
      ceremony.close()

      // Derived keys must never outlive the seed they came from.
      const fresh = beginCeremony('group-1')
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBeNull()
      fresh.close()
    })

    it('is returned by identity within one ceremony, and gone after it', () => {
      const signer = {sign: () => 'sig'}
      const first = beginCeremony('group-1')
      setCachedObject('group-1', 'evm-signer', signer, 'guard')
      // Same instance while the grant lasts — the point of caching an object.
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBe(signer)
      first.close()

      const second = beginCeremony('group-1')
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBeNull()
      second.close()
    })

    it('clearAllCeremonies drops objects', () => {
      const ceremony = beginCeremony('group-1')
      setCachedObject('group-1', 'evm-signer', {a: 1}, 'guard')

      clearAllCeremonies()

      const fresh = beginCeremony('group-1')
      expect(getCachedObject('group-1', 'evm-signer', 'guard')).toBeNull()
      fresh.close()
      ceremony.close()
    })
  })

  describe('material-kind namespacing', () => {
    it('mnemonic and xpriv share a ceremony but occupy independent slots', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words')
      setCachedMaterial('group-1', 'xpriv', 'ff00deadbeef')

      expect(getCachedMaterial('group-1', 'mnemonic')).toBe('twelve words')
      expect(getCachedMaterial('group-1', 'xpriv')).toBe('ff00deadbeef')
      ceremony.close()
    })

    it('xpriv read does not return a mnemonic stored under the same group', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve words')

      expect(getCachedMaterial('group-1', 'xpriv')).toBeNull()
      ceremony.close()
    })

    it('mnemonic read does not return an xpriv stored under the same group', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'xpriv', 'ff00deadbeef')

      expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
      ceremony.close()
    })

    it('closing wipes both kinds together', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'twelve')
      setCachedMaterial('group-1', 'xpriv', 'ff00')
      ceremony.close()

      const fresh = beginCeremony('group-1')
      expect(getCachedMaterial('group-1', 'mnemonic')).toBeNull()
      expect(getCachedMaterial('group-1', 'xpriv')).toBeNull()
      fresh.close()
    })

    it('inspector exposes which kinds are populated', () => {
      const ceremony = beginCeremony('group-1')
      setCachedMaterial('group-1', 'mnemonic', 'm')
      setCachedMaterial('group-1', 'xpriv', 'x')

      expect(__cacheInspectForTests?.().groups.get('group-1')).toEqual({
        tokenCount: 1,
        kinds: ['mnemonic', 'xpriv'],
        objectKeys: [],
      })
      ceremony.close()
    })
  })
})
