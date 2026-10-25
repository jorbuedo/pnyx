import {encodeHandle} from '@pnyx/contract-client/handle'
import {describe, expect, it} from 'vitest'
import {permitAddressIndex} from './handle-permit-address'

describe('permitAddressIndex', () => {
  it('is stable for one name, so a retry finds the permit already minted', () => {
    const name = encodeHandle('averyverylongnamethatfits')
    expect(permitAddressIndex(name)).toBe(permitAddressIndex(encodeHandle('averyverylongnamethatfits')))
  })

  // Case is a display choice: `Alice` and `alice` are one name and must share one permit address.
  it('folds case, because the canonical spelling is what decides the name', () => {
    expect(permitAddressIndex(encodeHandle('AVeryLongNameThatFits'))).toBe(
      permitAddressIndex(encodeHandle('averylongnamethatfits')),
    )
  })

  it('gives different names different addresses, so two claims are not linked', () => {
    expect(permitAddressIndex(encodeHandle('firstlongenoughname'))).not.toBe(
      permitAddressIndex(encodeHandle('secondlongenoughname')),
    )
  })

  // An out-of-range index is not a derivation, it is a crash inside BIP32. Three of these four names
  // hash to a digest starting ≥ 0x80, so the case where the shift itself goes negative is covered.
  it('always lands inside the 31-bit non-hardened range', () => {
    for (const name of [
      'aaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbb',
      'zzzzzzzzzzzzzzzzzzzzzzz',
      'longenoughname1',
    ]) {
      const index = permitAddressIndex(encodeHandle(name))
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(0x7fffffff)
    }
  })

  it('refuses a name that is not the fixed-width canonical form', () => {
    expect(() => permitAddressIndex(new Uint8Array(16))).toThrow(/32 bytes/)
  })
})
