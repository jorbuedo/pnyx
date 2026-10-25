/**
 * Pure sort / search / shuffle helpers for the pool + DRep picker lists.
 *
 * Random is the DEFAULT sort so delegation exposure is fair across pools/DReps
 * instead of compounding onto whatever ranks first; the shuffle is seeded
 * (mulberry32 + Fisher–Yates) so a given seed renders a stable order across
 * re-renders, and re-tapping Random supplies a fresh seed.
 *
 * @module
 */

import type {DRepListEntry} from './drep'
import type {PoolInfo} from './pool'

export type PoolSortMode = 'random' | 'roa' | 'alpha'
export type DRepSortMode = 'random' | 'power' | 'delegators' | 'alpha'

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seeded Fisher–Yates; same seed → same order. Input is not mutated. */
export const seededShuffle = <T>(items: readonly T[], seed: number): T[] => {
  const rand = mulberry32(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}

const alphaKey = (name: string | undefined, id: string): string => (name ?? id).toLowerCase()

/** Sort pools for the picker. Missing metric sorts last, never as 0. */
export const sortPools = (pools: readonly PoolInfo[], mode: PoolSortMode, seed: number): PoolInfo[] => {
  switch (mode) {
    case 'random':
      return seededShuffle(pools, seed)
    case 'roa':
      return [...pools].sort((a, b) => (b.roa ?? Number.NEGATIVE_INFINITY) - (a.roa ?? Number.NEGATIVE_INFINITY))
    case 'alpha':
      return [...pools].sort((a, b) => alphaKey(a.name, a.id).localeCompare(alphaKey(b.name, b.id)))
  }
}

/** Sort DReps for the picker. Missing metric sorts last, never as 0. */
export const sortDReps = (entries: readonly DRepListEntry[], mode: DRepSortMode, seed: number): DRepListEntry[] => {
  switch (mode) {
    case 'random':
      return seededShuffle(entries, seed)
    case 'power':
      return [...entries].sort((a, b) => {
        const av = a.votingPower ?? -1n
        const bv = b.votingPower ?? -1n
        return bv > av ? 1 : bv < av ? -1 : 0
      })
    case 'delegators':
      return [...entries].sort(
        (a, b) => (b.delegators ?? Number.NEGATIVE_INFINITY) - (a.delegators ?? Number.NEGATIVE_INFINITY),
      )
    case 'alpha':
      return [...entries].sort((a, b) => alphaKey(a.givenName, a.id).localeCompare(alphaKey(b.givenName, b.id)))
  }
}

/** Case-insensitive substring match on id / ticker / name. */
export const searchPools = (pools: readonly PoolInfo[], query: string): PoolInfo[] => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...pools]
  return pools.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      (p.ticker?.toLowerCase().includes(q) ?? false) ||
      (p.name?.toLowerCase().includes(q) ?? false),
  )
}

/** Name substring, or bech32 / hex id prefix. */
export const searchDReps = (entries: readonly DRepListEntry[], query: string): DRepListEntry[] => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...entries]
  return entries.filter(
    (d) =>
      (d.givenName?.toLowerCase().includes(q) ?? false) ||
      d.id.toLowerCase().startsWith(q) ||
      d.idHex.toLowerCase().startsWith(q),
  )
}

/** Stable-move every item matching `isPinned` to the front (relative order kept). */
export const pinFirst = <T>(items: readonly T[], isPinned: (item: T) => boolean): T[] => [
  ...items.filter(isPinned),
  ...items.filter((i) => !isPinned(i)),
]
