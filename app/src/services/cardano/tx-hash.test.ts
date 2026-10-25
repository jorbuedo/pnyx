import {describe, expect, it} from 'vitest'
import {isTxHash, txHashOf} from './tx-hash'

const HASH = '93248bcd8d1f7e347d20f790a32b7c097345ee3613a245178cf5177c970ee25e'

describe('txHashOf', () => {
  it('accepts a 64-character hex id and lowercases it', () => {
    expect(txHashOf(HASH)).toBe(HASH)
    expect(txHashOf(HASH.toUpperCase())).toBe(HASH)
    expect(txHashOf(`  ${HASH}  `)).toBe(HASH)
  })

  it('refuses anything that is not 32 bytes of hex', () => {
    // A tx id is a blake2b-256 digest. Everything here would 404 the review.
    for (const bad of ['', 'aabb', HASH.slice(0, 63), `${HASH}a`, 'z'.repeat(64), `${HASH.slice(0, 63)} `]) {
      expect(txHashOf(bad)).toBeNull()
    }
  })

  it('agrees with isTxHash', () => {
    expect(isTxHash(HASH)).toBe(true)
    expect(isTxHash('aabb')).toBe(false)
  })
})
