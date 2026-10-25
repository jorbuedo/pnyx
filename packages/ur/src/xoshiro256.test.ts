import {describe, expect, it} from 'vitest'
import {xoshiro256FromString} from './xoshiro256.js'

/**
 * The reference's `test_rng_1`: the first 100 raw draws, taken **modulo 100**, from a generator
 * seeded with "Wolf".
 *
 * ⚠️ It is `next() % 100`, not `nextInt(0, 99)` — the two disagree, and reading the vector as the
 * latter sends you looking for a bug in a correct state machine. So this pins the SHA-256
 * seeding, the big-endian digest read and the state update, and pins **nothing** about
 * `nextDouble` / `nextInt`. Those are covered by the fountain fragment vectors, which route
 * through the shuffle.
 */
const WOLF_100 = [
  42, 81, 85, 8, 82, 84, 76, 73, 70, 88, 2, 74, 40, 48, 77, 54, 88, 7, 5, 88, 37, 25, 82, 13, 69, 59, 30, 39, 11, 82,
  19, 99, 45, 87, 30, 15, 32, 22, 89, 44, 92, 77, 29, 78, 4, 92, 44, 68, 92, 69, 1, 42, 89, 50, 37, 84, 63, 34, 32, 3,
  17, 62, 40, 98, 82, 89, 24, 43, 85, 39, 15, 3, 99, 29, 20, 42, 27, 10, 85, 66, 50, 35, 69, 70, 70, 74, 30, 13, 72, 54,
  11, 5, 70, 55, 91, 52, 10, 43, 43, 52,
]

describe('xoshiro256**', () => {
  it('reproduces the reference "Wolf" sequence', () => {
    const rng = xoshiro256FromString('Wolf')
    const drawn = Array.from({length: 100}, () => Number(rng.next() % 100n))
    expect(drawn).toEqual(WOLF_100)
  })

  it('is deterministic for a given seed', () => {
    const a = xoshiro256FromString('Wolf')
    const b = xoshiro256FromString('Wolf')
    expect(Array.from({length: 20}, () => a.next())).toEqual(Array.from({length: 20}, () => b.next()))
  })

  it('diverges for different seeds', () => {
    const a = xoshiro256FromString('Wolf')
    const b = xoshiro256FromString('Wolg')
    expect(a.next()).not.toBe(b.next())
  })

  it('keeps draws inside 64 bits', () => {
    const rng = xoshiro256FromString('Wolf')
    for (let i = 0; i < 200; i++) {
      const value = rng.next()
      expect(value >= 0n && value < 1n << 64n).toBe(true)
    }
  })

  it('honours both ends of nextInt', () => {
    const rng = xoshiro256FromString('Wolf')
    const draws = Array.from({length: 500}, () => rng.nextInt(3, 7))
    expect(Math.min(...draws)).toBe(3)
    expect(Math.max(...draws)).toBe(7)
  })

  it('produces bytes in range', () => {
    const data = xoshiro256FromString('Wolf').nextData(512)
    expect(data).toHaveLength(512)
    expect(data.every((byte) => byte >= 0 && byte <= 255)).toBe(true)
  })
})
