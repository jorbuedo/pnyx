/**
 * BIP-39's PBKDF2, portable build.
 *
 * This is the non-React-Native version: pure JS via `@noble/hashes`, which is what Node, the
 * Cloudflare Workers and every vitest run use. React Native gets `pbkdf2.native.ts` instead, where
 * the same derivation runs through OpenSSL and is ~1000× faster.
 *
 * Split out of `seed.ts` so the platform-specific part is one 3-line function with a shared vector
 * test, rather than a branch inside the seed derivation itself.
 *
 * @module
 */

import {pbkdf2Async} from '@noble/hashes/pbkdf2.js'
import {sha512} from '@noble/hashes/sha2.js'

/**
 * PBKDF2-HMAC-SHA512, 2048 iterations, 64-byte output — BIP-39 §Seed, fixed rather than
 * parameterised because BIP-39 fixes them. `password` and `salt` are the already-normalised
 * (NFKD) mnemonic and `"mnemonic" + passphrase`.
 */
export const bip39Pbkdf2 = async (password: string, salt: string): Promise<Uint8Array> =>
  pbkdf2Async(sha512, password, salt, {c: 2048, dkLen: 64})
