import {describe, expect, it} from 'vitest'
import type {DRepListEntry} from './drep'
import {pinFirst, searchDReps, searchPools, seededShuffle, sortDReps, sortPools} from './picker-sort'
import type {PoolInfo} from './pool'

const pool = (id: string, over: Partial<PoolInfo> = {}): PoolInfo => ({
  id,
  idHex: `${id}-hex`,
  status: 'active',
  logoUrl: `https://ix.cexplorer.io/${id}`,
  ...over,
})

const drep = (id: string, over: Partial<DRepListEntry> = {}): DRepListEntry => ({
  id,
  idHex: `${id}-hex`,
  isScript: false,
  ...over,
})

describe('seededShuffle', () => {
  it('is stable for a seed, differs across seeds, and does not mutate input', () => {
    const items = Array.from({length: 20}, (_, i) => i)
    const frozen = [...items]
    const a = seededShuffle(items, 7)
    const b = seededShuffle(items, 7)
    const c = seededShuffle(items, 8)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(items).toEqual(frozen)
    expect([...a].sort((x, y) => x - y)).toEqual(frozen)
  })
})

describe('sortPools', () => {
  const pools = [
    pool('pool1c', {name: 'Charlie', roa: 2.1}),
    pool('pool1a', {name: 'alpha', roa: 4.5}),
    pool('pool1b', {roa: 3.0}),
    pool('pool1x', {name: 'Xi'}), // no ROA
  ]

  it('roa sorts descending with missing metric last', () => {
    expect(sortPools(pools, 'roa', 1).map((p) => p.id)).toEqual(['pool1a', 'pool1b', 'pool1c', 'pool1x'])
  })

  it('alpha sorts case-insensitively by name, falling back to id', () => {
    expect(sortPools(pools, 'alpha', 1).map((p) => p.id)).toEqual(['pool1a', 'pool1c', 'pool1b', 'pool1x'])
  })

  it('random is seed-stable', () => {
    expect(sortPools(pools, 'random', 42)).toEqual(sortPools(pools, 'random', 42))
  })
})

describe('sortDReps', () => {
  const dreps = [
    drep('drep1a', {givenName: 'Ada', votingPower: 5n, delegators: 2}),
    drep('drep1b', {votingPower: 9n, delegators: 7}),
    drep('drep1c', {givenName: 'bob'}), // no metrics
  ]

  it('power sorts by bigint voting power descending, missing last', () => {
    expect(sortDReps(dreps, 'power', 1).map((d) => d.id)).toEqual(['drep1b', 'drep1a', 'drep1c'])
  })

  it('delegators sorts descending, missing last', () => {
    expect(sortDReps(dreps, 'delegators', 1).map((d) => d.id)).toEqual(['drep1b', 'drep1a', 'drep1c'])
  })

  it('alpha uses givenName then id', () => {
    expect(sortDReps(dreps, 'alpha', 1).map((d) => d.id)).toEqual(['drep1a', 'drep1c', 'drep1b'])
  })
})

describe('search', () => {
  it('searchPools matches id/ticker/name substrings case-insensitively', () => {
    const pools = [pool('pool1abc', {ticker: 'AAA', name: 'Alpha'}), pool('pool1def', {ticker: 'BBB'})]
    expect(searchPools(pools, 'alp').map((p) => p.id)).toEqual(['pool1abc'])
    expect(searchPools(pools, 'bbb').map((p) => p.id)).toEqual(['pool1def'])
    expect(searchPools(pools, 'def').map((p) => p.id)).toEqual(['pool1def'])
    expect(searchPools(pools, '  ')).toHaveLength(2)
  })

  it('searchDReps matches name substring or id/hex prefix', () => {
    const dreps = [drep('drep1xyz', {givenName: 'Governance Guild', idHex: 'aa11'}), drep('drep1qqq', {idHex: 'bb22'})]
    expect(searchDReps(dreps, 'guild').map((d) => d.id)).toEqual(['drep1xyz'])
    expect(searchDReps(dreps, 'drep1q').map((d) => d.id)).toEqual(['drep1qqq'])
    expect(searchDReps(dreps, 'bb').map((d) => d.id)).toEqual(['drep1qqq'])
    expect(searchDReps(dreps, 'zzz')).toHaveLength(0)
  })
})

describe('pinFirst', () => {
  it('moves matches to the front preserving relative order', () => {
    expect(pinFirst([1, 2, 3, 4, 5], (n) => n % 2 === 0)).toEqual([2, 4, 1, 3, 5])
  })
})
