import {describe, expect, it} from 'vitest'
import {crc32, crc32Bytes} from './crc32.js'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('crc32', () => {
  // The check value every CRC-32 implementation publishes, so a wrong polynomial or a
  // missing final XOR fails here rather than three layers up.
  it('matches the standard check vector', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0)
  })

  // From BCR-2024-001, which uses "Wolf" as its worked example throughout — including as the
  // fountain RNG seed, so this same value has to be right for part selection later.
  it('matches the Blockchain Commons "Wolf" vector', () => {
    expect(crc32(utf8('Wolf'))).toBe(0x598c84dc)
  })

  it('serializes big-endian', () => {
    expect(Array.from(crc32Bytes(utf8('Wolf')))).toEqual([0x59, 0x8c, 0x84, 0xdc])
  })

  it('is not confused by high bytes', () => {
    expect(crc32(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toBe(0xffffffff)
  })
})
