import {describe, expect, it} from 'vitest'
import {crc32} from './crc32.js'
import {chooseFragments, findNominalFragmentLength, partitionMessage, xorFragments, xorInto} from './fountain.js'
import {xoshiro256FromString} from './xoshiro256.js'

/** The reference's `make_message`: `len` bytes from a generator seeded with the given string. */
const makeMessage = (length: number, seed = 'Wolf'): Uint8Array => xoshiro256FromString(seed).nextData(length)

const hex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * `test_choose_fragments`: a 1024-byte "Wolf" message in 11 fragments, sequence numbers 1..30.
 *
 * This is the vector that pins the parts the `"Wolf"` RNG vector cannot — `nextDouble`,
 * `nextInt`'s inclusive bound, the alias sampler's construction order, and the number of draws
 * each stage takes. Any of those being subtly wrong leaves parts 1..11 correct (they are pure)
 * and corrupts everything after, which is exactly the failure this suite exists to prevent.
 */
const EXPECTED_FRAGMENT_SETS: readonly (readonly number[])[] = [
  [0],
  [1],
  [2],
  [3],
  [4],
  [5],
  [6],
  [7],
  [8],
  [9],
  [10],
  [9],
  [2, 5, 6, 8, 9, 10],
  [8],
  [1, 5],
  [1],
  [0, 2, 4, 5, 8, 10],
  [5],
  [2],
  [2],
  [0, 1, 3, 4, 5, 7, 9, 10],
  [0, 1, 2, 3, 5, 6, 8, 9, 10],
  [0, 2, 4, 5, 7, 8, 9, 10],
  [3, 5],
  [4],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [0, 1, 3, 4, 5, 6, 7, 9, 10],
  [6],
  [5, 6],
  [7],
]

describe('fragment length and partitioning', () => {
  // 256 bytes at a 30-byte ceiling needs 9 fragments, so 29 bytes each — the reference's own
  // encoder setup, and the numbers the part vectors below depend on.
  it('finds the reference nominal length', () => {
    expect(findNominalFragmentLength(256, 30)).toBe(29)
  })

  it('pads the final fragment rather than shortening it', () => {
    const fragments = partitionMessage(makeMessage(256), 29)
    expect(fragments).toHaveLength(9)
    expect(fragments.every((fragment) => fragment.length === 29)).toBe(true)
    // 9 × 29 = 261, so the last five bytes are padding.
    expect(fragments.slice(-1).map((fragment) => Array.from(fragment.subarray(24)))).toEqual([[0, 0, 0, 0, 0]])
  })

  it('rejects a ceiling below the floor', () => {
    expect(() => findNominalFragmentLength(256, 5)).toThrow(/below minFragmentLength/)
  })
})

describe('chooseFragments against the reference vectors', () => {
  const message = makeMessage(1024)
  const checksum = crc32(message)
  const seqLen = 11

  it('matches all 30 published index sets', () => {
    const actual = Array.from({length: 30}, (_, i) => chooseFragments(i + 1, seqLen, checksum))
    expect(actual).toEqual(EXPECTED_FRAGMENT_SETS)
  })

  it('gives parts 1..seqLen exactly one fragment, in order', () => {
    for (let seqNum = 1; seqNum <= seqLen; seqNum++) {
      expect(chooseFragments(seqNum, seqLen, checksum)).toEqual([seqNum - 1])
    }
  })

  it('is deterministic and depends on the checksum', () => {
    expect(chooseFragments(13, seqLen, checksum)).toEqual(chooseFragments(13, seqLen, checksum))
    expect(chooseFragments(13, seqLen, checksum ^ 1)).not.toEqual(chooseFragments(13, seqLen, checksum))
  })

  it('never returns an out-of-range or duplicated index', () => {
    for (let seqNum = 1; seqNum <= 200; seqNum++) {
      const chosen = chooseFragments(seqNum, seqLen, checksum)
      expect(chosen.length).toBeGreaterThan(0)
      expect(new Set(chosen).size).toBe(chosen.length)
      expect(chosen.every((index) => index >= 0 && index < seqLen)).toBe(true)
    }
  })

  it('rejects a zero sequence number', () => {
    expect(() => chooseFragments(0, seqLen, checksum)).toThrow(/at least 1/)
  })
})

describe('the reference encoder vectors', () => {
  const message = makeMessage(256)
  const fragments = partitionMessage(message, findNominalFragmentLength(256, 30))

  // The checksum the reference reports for this exact message. It ties makeMessage — and so
  // `nextInt`, via nextByte — to the published value rather than to our own generator.
  it('reproduces the published checksum', () => {
    expect(crc32(message)).toBe(23570951)
  })

  it('reproduces the first three parts, which are pure fragments', () => {
    expect(fragments.slice(0, 3).map(hex)).toEqual([
      '916ec65cf77cadf55cd7f9cda1a1030026ddd42e905b77adc36e4f2d3c',
      'cba44f7f04f2de44f42d84c374a0e149136f25b01852545961d55f7f7a',
      '8cde6d0e2ec43f3b2dcb644a2209e8c9e34af5c4747984a5e873c9cf5f',
    ])
  })
})

describe('xor', () => {
  it('is its own inverse', () => {
    const a = makeMessage(29)
    const b = makeMessage(29, 'Fox')
    const mixed = xorFragments([a, b], 29)
    xorInto(mixed, b)
    expect(Array.from(mixed)).toEqual(Array.from(a))
  })

  it('refuses mismatched lengths rather than truncating', () => {
    expect(() => xorInto(new Uint8Array(4), new Uint8Array(5))).toThrow(/cannot xor/)
  })
})
