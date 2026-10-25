import {describe, expect, it} from 'vitest'

import {
  assertCallEncodingSupported,
  encodeCompact,
  encodeSendMnTransaction,
  MIDNIGHT_CALL_ENCODING,
} from './substrate-extrinsic'

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe('encodeCompact', () => {
  it('encodes the single-byte mode below 64', () => {
    expect(hexOf(encodeCompact(0))).toBe('00')
    expect(hexOf(encodeCompact(1))).toBe('04')
    expect(hexOf(encodeCompact(63))).toBe('fc')
  })

  it('encodes the two-byte mode from 64 to 2^14 - 1', () => {
    expect(hexOf(encodeCompact(64))).toBe('0101')
    expect(hexOf(encodeCompact(16383))).toBe('fdff')
  })

  it('encodes the four-byte mode from 2^14 to 2^30 - 1', () => {
    expect(hexOf(encodeCompact(16384))).toBe('02000100')
    expect(hexOf(encodeCompact(1073741823))).toBe('feffffff')
  })

  it('encodes the big-integer mode at 2^30 and above', () => {
    // 2^30 needs four value bytes, so the prefix is ((4 - 4) << 2) | 0b11 = 0x03.
    expect(hexOf(encodeCompact(1073741824))).toBe('0300000040')
    // 2^32 needs five, so the prefix is ((5 - 4) << 2) | 0b11 = 0x07.
    expect(hexOf(encodeCompact(4294967296n))).toBe('070000000001')
  })

  it('refuses a negative value rather than encoding its two’s complement', () => {
    expect(() => encodeCompact(-1)).toThrow(/negative/)
  })
})

describe('encodeSendMnTransaction', () => {
  it('reproduces a real preprod extrinsic’s framing', () => {
    // Preprod block 0x21c295 carries an extrinsic of 11,970 bytes whose body begins
    // `04 05 00 ed ba 6d …`: v4-unsigned, pallet 5, call 0, then compact(11963) = `ed ba`, then the
    // transaction, whose own first byte is `6d`. Rebuilding the framing around a transaction of that
    // length must land on the same bytes, outer two-byte prefix `01 bb` = 11,968 included.
    const transaction = new Uint8Array(11963)
    transaction[0] = 0x6d

    const extrinsic = encodeSendMnTransaction(transaction)

    expect(extrinsic.length).toBe(11970)
    expect(hexOf(extrinsic.subarray(0, 8))).toBe('01bb040500edba6d')
    expect(extrinsic.subarray(7)).toEqual(transaction)
  })

  it('carries the transaction bytes through untouched', () => {
    const transaction = Uint8Array.from([1, 2, 3, 4])
    const extrinsic = encodeSendMnTransaction(transaction)

    // Body is v4 + pallet + call + compact(4) + 4 bytes = 8, so the outer prefix is compact(8) = 0x20.
    expect(hexOf(extrinsic)).toBe('200405001001020304')
  })

  it('refuses an empty transaction', () => {
    expect(() => encodeSendMnTransaction(new Uint8Array(0))).toThrow(/empty/)
  })
})

describe('assertCallEncodingSupported', () => {
  it('accepts the runtime the indices were decoded from', () => {
    expect(() =>
      assertCallEncodingSupported({
        specName: MIDNIGHT_CALL_ENCODING.specName,
        transactionVersion: MIDNIGHT_CALL_ENCODING.transactionVersion,
      }),
    ).not.toThrow()
  })

  it('refuses another chain’s runtime', () => {
    expect(() => assertCallEncodingSupported({specName: 'polkadot', transactionVersion: 3})).toThrow(/not 'midnight'/)
  })

  it('refuses a transactionVersion bump rather than dispatching an unknown call', () => {
    expect(() =>
      assertCallEncodingSupported({
        specName: 'midnight',
        transactionVersion: MIDNIGHT_CALL_ENCODING.transactionVersion + 1,
      }),
    ).toThrow(/state_getMetadata/)
  })
})
