import {describe, expect, it} from 'vitest'
import {
  formatDerivationPath,
  HARDENED,
  harden,
  isHardened,
  parseDerivationPath,
  requireDerivationPath,
  unharden,
} from './shared'

describe('parseDerivationPath', () => {
  it('parses hardened and unhardened components', () => {
    expect(parseDerivationPath("m/1852'/1815'/0'/0/0")).toEqual([HARDENED + 1852, HARDENED + 1815, HARDENED, 0, 0])
  })

  it("accepts 'h' as a hardening marker", () => {
    expect(parseDerivationPath('m/44h/60h/0h/0/0')).toEqual(parseDerivationPath("m/44'/60'/0'/0/0"))
  })

  it('round-trips through formatDerivationPath', () => {
    for (const path of ["m/1852'/1815'/0'/2/0", "m/44'/60'/0'/0/5", "m/44'/0'/0'/0/0"]) {
      expect(formatDerivationPath(parseDerivationPath(path))).toBe(path)
    }
  })

  // The array below is handed to a hardware device verbatim. A component that is not an index has
  // no safe reading, and `parseInt` gave every one of these a reading anyway.
  it('refuses a component that is not an index, instead of deriving NaN', () => {
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/zz")).toThrow(/not an index/)
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/")).toThrow(/not an index/)
    expect(() => parseDerivationPath('m//0')).toThrow(/not an index/)
  })

  // The one that matters: parseInt('1e3', 10) is 1, so this used to be a VALID path to a
  // DIFFERENT key than the one the caller named. A wrong-key signature, from a typo.
  it('refuses exponent notation rather than silently deriving a different key', () => {
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/1e3")).toThrow(/not an index/)
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/0x10")).toThrow(/not an index/)
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/ 5")).toThrow(/not an index/)
    expect(() => parseDerivationPath("m/1852'/1815'/0'/0/-1")).toThrow(/not an index/)
  })

  it('refuses a path that names no indices', () => {
    expect(() => parseDerivationPath('')).toThrow(/names no indices/)
    expect(() => parseDerivationPath('m/')).toThrow(/names no indices/)
  })

  // A component at or above 2^31 would collide with the hardening bit, so a hardened index
  // written unhardened must not quietly become its hardened twin.
  it('refuses an index that collides with the hardening bit', () => {
    expect(() => parseDerivationPath(`m/${HARDENED}`)).toThrow(/out of range/)
    expect(() => parseDerivationPath(`m/${HARDENED + 1}'`)).toThrow(/out of range/)
    expect(parseDerivationPath(`m/${HARDENED - 1}`)).toEqual([HARDENED - 1])
  })
})

describe('requireDerivationPath', () => {
  it('parses a path that is present', () => {
    expect(requireDerivationPath("m/1852'/1815'/0'/2/0", 'stakingPath')).toEqual(
      parseDerivationPath("m/1852'/1815'/0'/2/0"),
    )
  })

  // The device adapters used to write `parseDerivationPath(params.stakingPath ?? '')`, which made
  // "the caller omitted this" into a path of one NaN component and sent it to the device.
  it('names the missing field instead of fabricating a path', () => {
    expect(() => requireDerivationPath(undefined, 'base address stakingPath')).toThrow(
      /base address stakingPath is required/,
    )
    expect(() => requireDerivationPath('', 'reward address stakingPath')).toThrow(
      /reward address stakingPath is required/,
    )
  })
})

describe('hardening helpers', () => {
  it('hardens, unhardens and reports', () => {
    expect(harden(1852)).toBe(HARDENED + 1852)
    expect(unharden(HARDENED + 1852)).toBe(1852)
    expect(unharden(5)).toBe(5)
    expect(isHardened(HARDENED)).toBe(true)
    expect(isHardened(HARDENED - 1)).toBe(false)
  })
})
