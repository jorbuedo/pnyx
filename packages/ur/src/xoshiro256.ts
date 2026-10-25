/**
 * Xoshiro256** — the PRNG that makes fountain part selection deterministic.
 *
 * This is not a random-number generator in the usual sense: encoder and decoder must derive the
 * *same* fragment indexes from the same `(seqNum, checksum)`, so every detail here is protocol,
 * not implementation choice. In particular the digest is read **big-endian** into the state, and
 * `nextInt` is **inclusive of both bounds** — get either wrong and pure parts still decode while
 * mixed ones silently resolve to the wrong fragments.
 *
 * @module
 */

import {sha256} from '@pnyx/crypto'

const MASK64 = (1n << 64n) - 1n
const TWO_64 = 2 ** 64

const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (64n - k))) & MASK64

export type Xoshiro256 = {
  /** The raw 64-bit draw. */
  readonly next: () => bigint
  /** A double in [0, 1). */
  readonly nextDouble: () => number
  /** An integer in [low, high] — **both ends inclusive**, matching the reference. */
  readonly nextInt: (low: number, high: number) => number
  /** A byte in [0, 255]. */
  readonly nextByte: () => number
  /** `count` bytes, each a `nextByte()`. */
  readonly nextData: (count: number) => Uint8Array
}

/** Seed the state from a 32-byte digest: bytes 0–7 → s0, 8–15 → s1, 16–23 → s2, 24–31 → s3. */
const stateFromDigest = (digest: Uint8Array): [bigint, bigint, bigint, bigint] => {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  return [
    view.getBigUint64(0, false),
    view.getBigUint64(8, false),
    view.getBigUint64(16, false),
    view.getBigUint64(24, false),
  ]
}

/**
 * A generator seeded by SHA-256 over `seed`.
 *
 * The hash is part of the protocol, not defensive hygiene — the reference seeds from the digest
 * of the seed bytes, so seeding from the bytes directly would produce a different stream.
 */
export const xoshiro256 = (seed: Uint8Array): Xoshiro256 => {
  let [s0, s1, s2, s3] = stateFromDigest(sha256(seed))

  const next = (): bigint => {
    const result = (rotl((s1 * 5n) & MASK64, 7n) * 9n) & MASK64
    const t = (s1 << 17n) & MASK64
    s2 ^= s0
    s3 ^= s1
    s1 ^= s2
    s0 ^= s3
    s2 ^= t
    s3 = rotl(s3, 45n)
    return result
  }

  // `Number(u64) / 2^64` reproduces the reference's uint64→double conversion, including its
  // loss of the low bits — matching it is the point, so do not "improve" this to full precision.
  const nextDouble = (): number => Number(next()) / TWO_64
  const nextInt = (low: number, high: number): number => Math.floor(nextDouble() * (high - low + 1)) + low
  const nextByte = (): number => nextInt(0, 255)

  return {
    next,
    nextDouble,
    nextInt,
    nextByte,
    nextData: (count: number): Uint8Array => Uint8Array.from({length: count}, nextByte),
  }
}

/** Convenience for the spec's worked examples, which seed from an ASCII string. */
export const xoshiro256FromString = (seed: string): Xoshiro256 => xoshiro256(new TextEncoder().encode(seed))
