import type {AddressRow} from '@pnyx/store/address-table'
import {describe, expect, it} from 'vitest'
import {
  addressPathsFingerprint,
  derivationPathsByAddress,
  railAddressSetFromRows,
  stringsFingerprint,
} from './address-paths'

const row = (over: Partial<AddressRow>): AddressRow => ({
  groupId: 'g1',
  chainId: 'cardano:mainnet',
  accountIndex: 0,
  branch: 'external',
  index: 0,
  human: 'addr1q0',
  hash: 'aa',
  isUsed: true,
  ...over,
})

describe('derivationPathsByAddress', () => {
  it('maps receive addresses to role 0 and change addresses to role 1', () => {
    const paths = derivationPathsByAddress([
      row({human: 'addr1receive', branch: 'external', index: 12}),
      row({human: 'addr1change', branch: 'internal', index: 3}),
    ])

    expect(paths.get('addr1receive')).toBe("m/1852'/1815'/0'/0/12")
    expect(paths.get('addr1change')).toBe("m/1852'/1815'/0'/1/3")
  })

  it('keeps the account index of each row', () => {
    const paths = derivationPathsByAddress([row({human: 'addr1acct2', accountIndex: 2, index: 7})])

    expect(paths.get('addr1acct2')).toBe("m/1852'/1815'/2'/0/7")
  })

  it('omits rows it cannot place, rather than inventing a role or address', () => {
    const paths = derivationPathsByAddress([
      row({human: '', index: 1}),
      row({human: 'addr1single', branch: 'single', index: 1}),
    ])

    expect(paths.size).toBe(0)
  })
})

describe('railAddressSetFromRows', () => {
  // The regression this exists for: a freshly imported Ledger claimed cNIGHT, the claim
  // paid one output to address 0 and one to a derived address the book already held but
  // had marked unused. Seeding credentials from used rows only meant that address's
  // payment credential never reached the UTxO query, so the NIGHT output was never asked
  // about — while history, which reads at stake-credential level, showed the claim fine.
  it('gives an unused derived row a path, so its credential still reaches the UTxO query', () => {
    const set = railAddressSetFromRows(
      [row({human: 'addr1primary', index: 0, isUsed: true}), row({human: 'addr1holds_night', index: 4, isUsed: false})],
      'addr1primary',
    )

    expect(set.paths.get('addr1holds_night')).toBe("m/1852'/1815'/0'/0/4")
    expect(set.beyondPrimary).toContain('addr1holds_night')
  })

  it('keeps knownUsed to what a previous scan proved, since it only makes the next scan cheaper', () => {
    const set = railAddressSetFromRows(
      [row({human: 'addr1used', isUsed: true}), row({human: 'addr1fresh', index: 1, isUsed: false})],
      'addr1other',
    )

    expect(set.knownUsed).toEqual(['addr1used'])
  })

  it("excludes the primary from beyondPrimary, which is the rail's extraAddresses", () => {
    const set = railAddressSetFromRows(
      [row({human: 'addr1primary', index: 0}), row({human: 'addr1second', index: 1})],
      'addr1primary',
    )

    expect(set.beyondPrimary).toEqual(['addr1second'])
  })

  it('carries no address it cannot derive a path for', () => {
    const set = railAddressSetFromRows([row({human: 'addr1single', branch: 'single', isUsed: true})], 'addr1primary')

    expect(set.paths.size).toBe(0)
    expect(set.beyondPrimary).toEqual([])
  })
})

describe('addressPathsFingerprint', () => {
  const paths = (pairs: readonly (readonly [string, string])[]): ReadonlyMap<string, string> => new Map(pairs)

  // The regression: the rail cache key carried `paths.size`, so two different address
  // sets of equal size were one entry and the second caller got a rail scoped to the
  // first one's addresses.
  it('separates two different sets of the same size', () => {
    const a = addressPathsFingerprint(paths([['addr1a', "m/1852'/1815'/0'/0/0"]]))
    const b = addressPathsFingerprint(paths([['addr1b', "m/1852'/1815'/0'/0/1"]]))

    expect(a).not.toBe(b)
  })

  it('is independent of insertion order, so one set has one fingerprint', () => {
    const forward = paths([
      ['addr1a', "m/1852'/1815'/0'/0/0"],
      ['addr1b', "m/1852'/1815'/0'/0/1"],
    ])
    const reversed = paths([
      ['addr1b', "m/1852'/1815'/0'/0/1"],
      ['addr1a', "m/1852'/1815'/0'/0/0"],
    ])

    expect(addressPathsFingerprint(forward)).toBe(addressPathsFingerprint(reversed))
  })

  it('changes when an address keeps its place but its path does not', () => {
    const before = addressPathsFingerprint(paths([['addr1a', "m/1852'/1815'/0'/0/0"]]))
    const after = addressPathsFingerprint(paths([['addr1a', "m/1852'/1815'/0'/1/0"]]))

    expect(before).not.toBe(after)
  })

  it('does not let two sets concatenate into the same byte stream', () => {
    const split = addressPathsFingerprint(
      paths([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    )
    const joined = addressPathsFingerprint(paths([['a', 'b\nc=d']]))

    expect(split).not.toBe(joined)
  })

  it('treats absent and empty alike, and never collides with a populated set', () => {
    expect(addressPathsFingerprint(undefined)).toBe('0')
    expect(addressPathsFingerprint(paths([]))).toBe('0')
    expect(addressPathsFingerprint(paths([['addr1a', "m/1852'/1815'/0'/0/0"]]))).not.toBe('0')
  })
})

describe('stringsFingerprint', () => {
  // This is the rail's address *coverage*: the set a stored watermark speaks for. A
  // primary-only rail and a 69-address rail must never produce the same value, or the
  // wider one trusts the narrower one's watermark and skips the fetch entirely.
  it('separates a narrower address set from a wider one', () => {
    expect(stringsFingerprint(['addr1a'])).not.toBe(stringsFingerprint(['addr1a', 'addr1b']))
  })

  it('is order- and duplicate-insensitive, because both describe the same covered set', () => {
    expect(stringsFingerprint(['addr1b', 'addr1a'])).toBe(stringsFingerprint(['addr1a', 'addr1b']))
    expect(stringsFingerprint(['addr1a', 'addr1a', 'addr1b'])).toBe(stringsFingerprint(['addr1a', 'addr1b']))
  })

  it('separates equal-sized sets that differ in content', () => {
    expect(stringsFingerprint(['addr1a', 'addr1b'])).not.toBe(stringsFingerprint(['addr1a', 'addr1c']))
  })

  it('does not let two sets concatenate into the same byte stream', () => {
    expect(stringsFingerprint(['a', 'b'])).not.toBe(stringsFingerprint(['a\nb']))
  })

  it('gives the empty set a value no populated set can take', () => {
    expect(stringsFingerprint([])).toBe('0')
    expect(stringsFingerprint(['addr1a'])).not.toBe('0')
  })
})
