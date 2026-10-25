import {describe, expect, it} from 'vitest'
import {bytes32} from './bytes'
import {decodeCircleInvite, encodeCircleInvite} from './circle-invite'
import {encodePnyxId} from './identity'

const SECRET = bytes32(0x2a)

describe('circle invite codes', () => {
  it('round-trips a secret', () => {
    expect(decodeCircleInvite(encodeCircleInvite(SECRET))).toEqual(SECRET)
  })

  it('is prefixed so a reader can tell what it is', () => {
    expect(encodeCircleInvite(SECRET).startsWith('pnyx_invite1')).toBe(true)
  })

  // The whole reason for bech32m over hex: a mistyped code must fail here rather than hash to a
  // commitment no circle holds, which would tell the user their invite was refused when they had
  // simply typed it wrong.
  it('refuses a code with a broken checksum', () => {
    const code = encodeCircleInvite(SECRET)
    const flipped = `${code.slice(0, -1)}${code.endsWith('q') ? 'p' : 'q'}`
    expect(() => decodeCircleInvite(flipped)).toThrow()
  })

  // A `pnyx_id` is 32 bytes with a valid checksum too, so only the HRP separates them. Without that
  // check, pasting your own identity into the invite field would decode and then silently fail to
  // match any invite.
  it('refuses a pnyx_id, which is otherwise the same shape', () => {
    const identity = encodePnyxId(SECRET)
    expect(() => decodeCircleInvite(identity)).toThrow(/unexpected HRP/)
  })

  it('accepts surrounding whitespace, which a paste carries', () => {
    expect(decodeCircleInvite(`  ${encodeCircleInvite(SECRET)}\n`)).toEqual(SECRET)
  })

  it.each(['', 'not-an-invite', 'pnyx_invite1', 'pnyx_invite1qqqq'])('refuses %p', (value) => {
    expect(() => decodeCircleInvite(value)).toThrow()
  })

  it('refuses a payload that is not 32 bytes', () => {
    expect(() => encodeCircleInvite(new Uint8Array(31))).toThrow(/32 bytes/)
  })
})
