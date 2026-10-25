import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  decodeAccountXvk,
  decodeSharedKey,
  encodeAccountXvk,
  encodeSharedKey,
  prefixOf,
  SHARED_PREFIX,
} from './shared-key'

const XPUB_HEX = 'ab'.repeat(64) // 64 bytes: pubkey ‖ chain code
const HASH_HEX = 'cd'.repeat(28) // 28 bytes: blake2b-224

const right = <A>(e: Either.Either<A, unknown>): A => {
  if (Either.isLeft(e)) throw new Error(`expected right, got ${JSON.stringify(e.left)}`)
  return e.right
}
const left = <E>(e: Either.Either<unknown, E>): E => {
  if (Either.isRight(e)) throw new Error(`expected left, got ${JSON.stringify(e.right)}`)
  return e.left
}

describe('account xvk round trip', () => {
  it('encodes under the CIP-5 shared prefix and decodes back', () => {
    const encoded = right(encodeAccountXvk(XPUB_HEX))
    expect(encoded.startsWith('acct_shared_xvk1')).toBe(true)
    expect(right(decodeAccountXvk(encoded))).toBe(XPUB_HEX)
  })

  it('survives the 90-char default bech32 limit', () => {
    // A 64-byte payload encodes to ~118 chars — the default limit would throw.
    expect(right(encodeAccountXvk(XPUB_HEX)).length).toBeGreaterThan(90)
  })

  it('tolerates surrounding whitespace on decode', () => {
    const encoded = right(encodeAccountXvk(XPUB_HEX))
    expect(right(decodeAccountXvk(`  ${encoded}\n`))).toBe(XPUB_HEX)
  })
})

describe('key hash round trip', () => {
  it('round-trips payment and stake hashes under their own prefixes', () => {
    const payment = right(encodeSharedKey(SHARED_PREFIX.paymentVkh, HASH_HEX))
    const stake = right(encodeSharedKey(SHARED_PREFIX.stakeVkh, HASH_HEX))
    expect(payment.startsWith('addr_shared_vkh1')).toBe(true)
    expect(stake.startsWith('stake_shared_vkh1')).toBe(true)
    expect(right(decodeSharedKey(SHARED_PREFIX.paymentVkh, payment))).toBe(HASH_HEX)
    expect(right(decodeSharedKey(SHARED_PREFIX.stakeVkh, stake))).toBe(HASH_HEX)
  })
})

describe('rejections', () => {
  it('refuses a stake key where a payment key is expected', () => {
    const stake = right(encodeSharedKey(SHARED_PREFIX.stakeVkh, HASH_HEX))
    expect(left(decodeSharedKey(SHARED_PREFIX.paymentVkh, stake))).toEqual({
      kind: 'wrong-prefix',
      expected: SHARED_PREFIX.paymentVkh,
      actual: SHARED_PREFIX.stakeVkh,
    })
  })

  it('refuses an ordinary CIP-1852 account key in a shared slot', () => {
    // The whole point of the CIP-5 prefixes: acct_xvk is a 1852 key, not a 1854 one.
    const ordinary = right(encodeSharedKey(SHARED_PREFIX.accountXvk, XPUB_HEX)).replace('acct_shared_xvk1', 'acct_xvk1')
    expect(left(decodeAccountXvk(ordinary)).kind).toBe('malformed') // checksum binds the prefix
  })

  it('refuses a payload of the wrong length', () => {
    expect(left(encodeAccountXvk(HASH_HEX))).toEqual({kind: 'wrong-length', expected: 64, actual: 28})
  })

  it('refuses non-hex input', () => {
    expect(left(encodeAccountXvk('zz')).kind).toBe('malformed')
  })

  it('refuses a corrupted checksum', () => {
    const encoded = right(encodeAccountXvk(XPUB_HEX))
    const corrupted = `${encoded.slice(0, -1)}${encoded.endsWith('q') ? 'p' : 'q'}`
    expect(left(decodeAccountXvk(corrupted)).kind).toBe('malformed')
  })

  it('refuses plain text', () => {
    expect(left(decodeAccountXvk('not a key')).kind).toBe('malformed')
  })
})

describe('prefixOf', () => {
  it('reads the prefix so a scanned value can be routed', () => {
    expect(prefixOf(right(encodeAccountXvk(XPUB_HEX)))).toBe('acct_shared_xvk')
    expect(prefixOf('addr_test1qq…')).toBe('addr_test')
  })

  it('returns null when there is no separator', () => {
    expect(prefixOf('nosep')).toBeNull()
    expect(prefixOf('1leading')).toBeNull()
  })
})
