import {encodePnyxId, pnyxIdEquals} from '@pnyx/contract-client/identity'
import {Multiavatar} from '@pnyx/identicon'
import {describe, expect, it} from 'vitest'
import {identityAvatarSeed} from './identity-avatar-seed'

const idOf = (fill: number) => encodePnyxId(new Uint8Array(32).fill(fill))

describe('identityAvatarSeed', () => {
  it('is the canonical bytes of C, hex', () => {
    expect(identityAvatarSeed(idOf(0x07))).toBe('07'.repeat(32))
  })

  it('gives one face to one identity, however the id is spelled', () => {
    const id = idOf(0x2a)
    // The premise: bech32m is case-insensitive, so these really are the same identity.
    expect(pnyxIdEquals(id, id.toUpperCase())).toBe(true)
    expect(identityAvatarSeed(id.toUpperCase())).toBe(identityAvatarSeed(id))
  })

  it('draws the same avatar for both spellings — what seeding on the text got wrong', () => {
    const id = idOf(0x2a)
    const seeded = (value: string) => Multiavatar({seed: identityAvatarSeed(value) ?? ''}).asSvg()
    expect(seeded(id.toUpperCase())).toBe(seeded(id))
    // Guard the premise: the old text seed genuinely diverged, so this test is not vacuous.
    expect(Multiavatar({seed: id.toUpperCase()}).asSvg()).not.toBe(Multiavatar({seed: id}).asSvg())
  })

  it('separates identities', () => {
    expect(identityAvatarSeed(idOf(0x07))).not.toBe(identityAvatarSeed(idOf(0x08)))
  })

  // The face follows the identity, and the identity is the same on every deployment — so the avatar
  // a user picks at onboarding is the avatar they keep through the preprod→mainnet migration. That
  // holds because the seed is a function of `C`'s bytes and of nothing else.
  it('depends on C and nothing else', () => {
    expect(identityAvatarSeed(idOf(0x07))).toBe(identityAvatarSeed(idOf(0x07)))
    expect(identityAvatarSeed(idOf(0x07))).not.toBe(identityAvatarSeed(idOf(0x08)))
    expect(identityAvatarSeed(idOf(0x07))).toBe('07'.repeat(32))
  })

  it('refuses to draw a face for anything that is not an identity', () => {
    expect(identityAvatarSeed('night-owl')).toBeNull()
    expect(identityAvatarSeed('')).toBeNull()
    // An id-shaped string with a broken checksum must not seed an avatar either.
    expect(identityAvatarSeed(`${idOf(0x07).slice(0, -1)}x`)).toBeNull()
  })
})
