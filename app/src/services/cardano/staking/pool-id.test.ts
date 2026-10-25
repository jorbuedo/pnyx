import {bech32} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {isPoolId, poolKeyHashHex} from './pool-id'

const HASH_HEX = '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0'
const HASH = new Uint8Array(28).map((_, i) => (i * 7 + 3) & 0xff)
const POOL_ID = bech32.encode('pool', bech32.toWords(HASH), 1023)

describe('poolKeyHashHex', () => {
  it('decodes a pool id to its 28-byte key hash', () => {
    expect(POOL_ID.startsWith('pool1')).toBe(true)
    expect(poolKeyHashHex(POOL_ID)).toBe(HASH_HEX)
  })

  it('refuses the wrong hrp over an otherwise valid payload', () => {
    // `pool_test` is not a pool id, and neither is a DRep or an address. Matching
    // on a `pool` *prefix* rather than the hrp would accept all three.
    expect(poolKeyHashHex(bech32.encode('pool_test', bech32.toWords(HASH), 1023))).toBeNull()
    expect(poolKeyHashHex(bech32.encode('drep', bech32.toWords(HASH), 1023))).toBeNull()
  })

  it('refuses the right hrp over the wrong payload length', () => {
    expect(poolKeyHashHex(bech32.encode('pool', bech32.toWords(new Uint8Array(20)), 1023))).toBeNull()
    expect(poolKeyHashHex(bech32.encode('pool', bech32.toWords(new Uint8Array(32)), 1023))).toBeNull()
  })

  it('refuses anything that is not bech32 at all, without throwing', () => {
    for (const junk of ['', 'pool1abc', 'not a pool', 'pool1', '  ', 'POOL1QQQQ']) {
      expect(poolKeyHashHex(junk)).toBeNull()
    }
  })

  it('agrees with isPoolId', () => {
    expect(isPoolId(POOL_ID)).toBe(true)
    expect(isPoolId('pool1abc')).toBe(false)
  })
})
