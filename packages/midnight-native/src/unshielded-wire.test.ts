import {describe, expect, it} from 'vitest'

import {INPUT_RECORD_LEN, packUnshieldedInputs, type UnshieldedSpend} from './unshielded-wire'

const bytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)

const spend = (overrides: Partial<UnshieldedSpend> = {}): UnshieldedSpend => ({
  value: 1_000_000n,
  tokenType: bytes(0),
  intentHash: bytes(7),
  outputIndex: 3,
  ...overrides,
})

const unpack = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('packUnshieldedInputs', () => {
  it('lays each field out where the native decoder reads it', () => {
    const packed = unpack(packUnshieldedInputs([spend({value: 0x0102n, outputIndex: 0x0304})]))

    expect(packed.length).toBe(INPUT_RECORD_LEN)
    // u128 little-endian: the low byte first.
    expect([...packed.slice(0, 4)]).toEqual([0x02, 0x01, 0x00, 0x00])
    expect([...packed.slice(16, 48)]).toEqual([...bytes(0)])
    expect([...packed.slice(48, 80)]).toEqual([...bytes(7)])
    // u32 little-endian.
    expect([...packed.slice(80, 84)]).toEqual([0x04, 0x03, 0x00, 0x00])
  })

  it('packs one whole record per input', () => {
    const packed = unpack(packUnshieldedInputs([spend(), spend({outputIndex: 4}), spend({outputIndex: 5})]))
    expect(packed.length).toBe(3 * INPUT_RECORD_LEN)
  })

  it('carries a value past 2^53 without rounding', () => {
    const value = 12_712_997_288_999_987_988n
    const packed = unpack(packUnshieldedInputs([spend({value})]))
    let read = 0n
    for (let i = 15; i >= 0; i--) read = (read << 8n) | BigInt(packed[i] ?? 0)
    expect(read).toBe(value)
  })

  it('refuses an empty set rather than packing zero records', () => {
    expect(() => packUnshieldedInputs([])).toThrow(/no inputs/)
  })

  it('refuses a token type that is not 32 bytes', () => {
    expect(() => packUnshieldedInputs([spend({tokenType: new Uint8Array(31)})])).toThrow(/token type must be 32 bytes/)
  })

  it('refuses an intent hash that is not 32 bytes', () => {
    expect(() => packUnshieldedInputs([spend({intentHash: new Uint8Array(33)})])).toThrow(
      /intent hash must be 32 bytes/,
    )
  })

  it('names the offending input when one of several is malformed', () => {
    expect(() => packUnshieldedInputs([spend(), spend({intentHash: new Uint8Array(1)})])).toThrow(/input 1:/)
  })

  it('refuses a negative or oversized value rather than wrapping it', () => {
    expect(() => packUnshieldedInputs([spend({value: -1n})])).toThrow(/cannot be negative/)
    expect(() => packUnshieldedInputs([spend({value: 2n ** 128n})])).toThrow(/exceeds 128 bits/)
  })

  it('refuses a non-integer output index', () => {
    expect(() => packUnshieldedInputs([spend({outputIndex: 1.5})])).toThrow(/output index/)
    expect(() => packUnshieldedInputs([spend({outputIndex: -1})])).toThrow(/output index/)
  })
})
