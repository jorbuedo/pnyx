/**
 * The two content-plane → on-chain derivations, and the property both exist for.
 *
 * A circle's id and a proposal's content commitment are what their contract addresses are derived
 * from, so they must be **recomputable by anyone holding the public id** and must not collide with
 * each other. Neither is a secret; both are identifiers.
 */

import {describe, expect, it} from 'vitest'

import {CIRCLE_ID_BYTES, circleIdFromContentId, proposalContentFromContentId} from './circle-id'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('circleIdFromContentId', () => {
  it('is deterministic and 32 bytes', () => {
    const a = circleIdFromContentId('pnyx-preprod-demo')
    expect(a).toHaveLength(CIRCLE_ID_BYTES)
    expect(hex(a)).toBe(hex(circleIdFromContentId('pnyx-preprod-demo')))
  })

  it('separates ids that differ at all', () => {
    expect(hex(circleIdFromContentId('a'))).not.toBe(hex(circleIdFromContentId('b')))
  })

  it('refuses an empty id rather than hashing the label alone', () => {
    expect(() => circleIdFromContentId('')).toThrow(/required/)
  })
})

describe('proposalContentFromContentId', () => {
  it('is deterministic and 32 bytes', () => {
    const a = proposalContentFromContentId('prop-1')
    expect(a).toHaveLength(32)
    expect(hex(a)).toBe(hex(proposalContentFromContentId('prop-1')))
  })

  it('refuses an empty id', () => {
    expect(() => proposalContentFromContentId('')).toThrow(/required/)
  })

  it('does not collide with the circle derivation on the same string', () => {
    // ⚠️ The reason the labels are distinct. Both feed a contract address; the same string used as
    // both a circle id and a proposal id must not produce the same 32 bytes in the two roles, or one
    // could be presented as the other.
    const id = 'shared-identifier'
    expect(hex(proposalContentFromContentId(id))).not.toBe(hex(circleIdFromContentId(id)))
  })
})
