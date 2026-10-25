/**
 * Fountain-code part selection (BCR-2024-001).
 *
 * A message is cut into `seqLen` equal fragments. Parts 1..seqLen carry one fragment each; every
 * part after that carries the XOR of a pseudo-random subset, so a receiver that missed frames can
 * still finish without the sender knowing which ones. Both sides derive the same subsets from
 * `(seqNum, checksum)` alone.
 *
 * Everything here is consensus-critical between two devices that never speak: fragment length,
 * the seed's byte order, how many draws each step takes from the generator. It is validated
 * against the reference vectors rather than reasoned about.
 *
 * @module
 */

import {randomSampler} from './random-sampler.js'
import {xoshiro256} from './xoshiro256.js'

/** The reference's default floor; a fragment smaller than this wastes QR capacity on framing. */
export const MIN_FRAGMENT_LENGTH = 10

/**
 * The fragment length the encoder will use: the largest that still fits `maxFragmentLength`,
 * found by trying fragment counts upward from 1.
 */
export const findNominalFragmentLength = (
  messageLength: number,
  maxFragmentLength: number,
  minFragmentLength: number = MIN_FRAGMENT_LENGTH,
): number => {
  if (messageLength <= 0) throw new Error('fountain: messageLength must be positive')
  if (minFragmentLength <= 0) throw new Error('fountain: minFragmentLength must be positive')
  if (maxFragmentLength < minFragmentLength) {
    throw new Error(`fountain: maxFragmentLength ${maxFragmentLength} is below minFragmentLength ${minFragmentLength}`)
  }
  const maxFragmentCount = Math.max(1, Math.floor(messageLength / minFragmentLength))
  let fragmentLength = messageLength
  for (let count = 1; count <= maxFragmentCount; count++) {
    fragmentLength = Math.ceil(messageLength / count)
    if (fragmentLength <= maxFragmentLength) break
  }
  return fragmentLength
}

/** Cut the message into equal fragments, zero-padding the last one. */
export const partitionMessage = (message: Uint8Array, fragmentLength: number): readonly Uint8Array[] => {
  if (fragmentLength <= 0) throw new Error('fountain: fragmentLength must be positive')
  const count = Math.ceil(message.length / fragmentLength)
  return Array.from({length: count}, (_, i) => {
    const fragment = new Uint8Array(fragmentLength)
    fragment.set(message.subarray(i * fragmentLength, (i + 1) * fragmentLength))
    return fragment
  })
}

/** XOR `source` into `target` in place. The mixing operation, and its own inverse. */
export const xorInto = (target: Uint8Array, source: Uint8Array): void => {
  if (target.length !== source.length) {
    throw new Error(`fountain: cannot xor ${source.length} bytes into ${target.length}`)
  }
  for (const [i, byte] of source.entries()) {
    // biome-ignore lint/style/noNonNullAssertion: the two lengths are checked equal directly above.
    target[i] = target[i]! ^ byte
  }
}

/** XOR a set of equal-length fragments together. */
export const xorFragments = (fragments: readonly Uint8Array[], fragmentLength: number): Uint8Array => {
  const result = new Uint8Array(fragmentLength)
  for (const fragment of fragments) xorInto(result, fragment)
  return result
}

/** Draw a degree in [1, seqLen] from the harmonic distribution 1/1, 1/2, … 1/seqLen. */
export const chooseDegree = (seqLen: number, rng: {readonly nextDouble: () => number}): number => {
  const weights = Array.from({length: seqLen}, (_, i) => 1 / (i + 1))
  return randomSampler(weights).next(rng) + 1
}

/**
 * Fisher-Yates by removal — draws one index per remaining item, so the number of generator draws
 * depends on the list length. Returns a full permutation; callers take the prefix they need.
 */
export const shuffled = <T>(
  items: readonly T[],
  rng: {readonly nextInt: (low: number, high: number) => number},
): T[] => {
  const remaining = [...items]
  const result: T[] = []
  while (remaining.length > 0) {
    const index = rng.nextInt(0, remaining.length - 1)
    result.push(...remaining.splice(index, 1))
  }
  return result
}

/** Big-endian uint32, the seed's wire form. */
const uint32BE = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false)
  return bytes
}

/**
 * The fragment indexes a part carries, ascending.
 *
 * Parts 1..seqLen are "pure" — one fragment each, in order — which is what lets a receiver in
 * good conditions finish in exactly `seqLen` frames. Beyond that the subset is derived from a
 * generator seeded with `seqNum || checksum`, both big-endian uint32.
 */
export const chooseFragments = (seqNum: number, seqLen: number, checksum: number): readonly number[] => {
  if (seqNum < 1) throw new Error(`fountain: seqNum ${seqNum} must be at least 1`)
  if (seqLen < 1) throw new Error(`fountain: seqLen ${seqLen} must be at least 1`)
  if (seqNum <= seqLen) return [seqNum - 1]

  const seed = new Uint8Array(8)
  seed.set(uint32BE(seqNum), 0)
  seed.set(uint32BE(checksum), 4)
  const rng = xoshiro256(seed)

  // Order matters: the degree is drawn first and consumes generator output the shuffle would
  // otherwise have used.
  const degree = chooseDegree(seqLen, rng)
  const indexes = Array.from({length: seqLen}, (_, i) => i)
  return shuffled(indexes, rng)
    .slice(0, degree)
    .sort((a, b) => a - b)
}
