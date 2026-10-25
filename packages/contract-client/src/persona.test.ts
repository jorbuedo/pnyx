// Seed → per-circle persona derivation (spec §4.3). Pinned vectors are the drift guard: this
// derivation defines the on-device persona identity (member leaf + nullifiers hang off it), so a
// change here silently forks every device-derived member from the intended spec.
import {describe, expect, it} from 'vitest'
import {derivePersonaSk, forumRoot, personaSkFromForumRoot} from './persona.js'

/**
 * A small circleId as its 32-byte little-endian form — what `derivePersonaSk`'s numeric argument
 * encodes to, so the two entry points can be compared directly.
 */
const idBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(32)
  out[0] = n
  return out
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const SEED = new Uint8Array(32).fill(1)

describe('persona derivation', () => {
  it('is deterministic and 32 bytes', () => {
    expect(derivePersonaSk(SEED, 1n)).toEqual(derivePersonaSk(SEED, 1n))
    expect(forumRoot(SEED)).toEqual(forumRoot(SEED))
    expect(derivePersonaSk(SEED, 1n).length).toBe(32)
    expect(forumRoot(SEED).length).toBe(32)
  })

  it('gives a distinct persona per circle and per seed', () => {
    expect(hex(derivePersonaSk(SEED, 1n))).not.toBe(hex(derivePersonaSk(SEED, 2n)))
    const otherSeed = new Uint8Array(32).fill(2)
    expect(hex(derivePersonaSk(SEED, 1n))).not.toBe(hex(derivePersonaSk(otherSeed, 1n)))
    // forumRoot is circleId-independent (the per-circle split happens in the second HKDF).
    expect(hex(forumRoot(SEED))).not.toBe(hex(derivePersonaSk(SEED, 1n)))
  })

  // The derivation takes (seed, circleId) and nothing else. It used to take the network too, so a
  // persona could not be linked across chains; that bought nothing, because circles are not carried
  // across the preprod→mainnet migration and a redeployed circle has a different circleId, so
  // personas already diverge on that input. Pinned as arity because a third parameter reappearing
  // is exactly the regression this guards.
  it('takes no input beyond the seed and the circle', () => {
    expect(derivePersonaSk.length).toBe(2)
    expect(personaSkFromForumRoot.length).toBe(2)
  })

  it('derivePersonaSk == personaSkFromForumRoot(forumRoot(seed), …) (session-cached forumRoot path)', () => {
    expect(hex(personaSkFromForumRoot(forumRoot(SEED), idBytes(1)))).toBe(hex(derivePersonaSk(SEED, 1n)))
    expect(hex(personaSkFromForumRoot(forumRoot(SEED), idBytes(7)))).toBe(hex(derivePersonaSk(SEED, 7n)))
  })

  it('refuses a circleId that is not 32 bytes', () => {
    // The info string is a fixed prefix followed by exactly 32 bytes, so a short or long id would
    // silently derive a different persona rather than fail.
    expect(() => personaSkFromForumRoot(forumRoot(SEED), new Uint8Array(31))).toThrow(/must be 32 bytes/)
    expect(() => personaSkFromForumRoot(forumRoot(SEED), new Uint8Array(33))).toThrow(/must be 32 bytes/)
  })

  // ⚠️ FROZEN. `forumRoot` is the root of both the identity and the persona tree, so a change here
  // is a change to who every user *is* — not just to which contracts they use. Nothing migrates it.
  // Re-pin only alongside a deliberate, recorded decision to reset every identity.
  //
  // Circle contracts are still being iterated on, and that is a different thing: a redeployed circle
  // has a new `circleId`, which is an *input* here, so personas move without this derivation moving.
  it('matches the frozen spec vectors (seed = 0x01×32)', () => {
    expect(hex(forumRoot(SEED))).toBe('908372ee0c58bca23a56fe65e0a9dcd9d900e3304a73c84f78b406be5a8f2d9e')
    expect(hex(derivePersonaSk(SEED, 1n))).toBe('d3b2a9cfe629562ba47fea7e8e3e0f1f53a034fcef89bb361d88b8415e20f7cf')
    expect(hex(derivePersonaSk(SEED, 2n))).toBe('e68a5d6d22356fe1d14768b5959f77f4c10de18a6129783fcfdd5773c55f213c')
    expect(hex(derivePersonaSk(SEED, 7n))).toBe('ed51a88354367a5c91aa034fdcff178924497d5e1900c60f9ce90e6aca8dd3c4')
  })
})
