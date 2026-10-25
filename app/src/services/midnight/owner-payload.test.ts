import {describe, expect, it} from 'vitest'

import {midnightAddressOfOwner, midnightOwnerPayload} from './owner-payload'

/** A real preprod unshielded address — the sponsor's, from block 2,306,724. */
const PREPROD_ADDRESS = 'mn_addr_preprod1g84s5k7cxzw5fvxq3hgx4tjnse8nnp8s5wctep275catzsunah8q9e3aqx'

describe('midnightOwnerPayload', () => {
  it('reads the 32-byte owner out of an unshielded address', () => {
    const owner = midnightOwnerPayload(PREPROD_ADDRESS)
    expect(owner).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses anything that is not an unshielded address', () => {
    expect(midnightOwnerPayload('not an address')).toBeNull()
  })
})

describe('midnightAddressOfOwner', () => {
  // The round trip is the contract: whatever a transaction's facts report as an owner has to come back
  // as the address a person was shown when they chose it — otherwise they cannot check the recipient.
  it('is the inverse of midnightOwnerPayload', () => {
    const owner = midnightOwnerPayload(PREPROD_ADDRESS)
    expect(owner).not.toBeNull()
    expect(midnightAddressOfOwner(owner as string, 'preprod')).toBe(PREPROD_ADDRESS)
  })

  it('refuses a payload that is not 32 bytes rather than dressing it up', () => {
    expect(midnightAddressOfOwner('abcd', 'preprod')).toBeNull()
    expect(midnightAddressOfOwner('', 'preprod')).toBeNull()
  })

  it('refuses non-hex', () => {
    expect(midnightAddressOfOwner('zz'.repeat(32), 'preprod')).toBeNull()
  })

  // ⚠️ The network is part of the address: the same owner is a different string on preprod and
  // mainnet, and showing the wrong one would invite a person to "verify" against an address that does
  // not exist on the network they are on.
  it('encodes the same owner differently per network', () => {
    const owner = midnightOwnerPayload(PREPROD_ADDRESS) as string
    expect(midnightAddressOfOwner(owner, 'mainnet')).not.toBe(midnightAddressOfOwner(owner, 'preprod'))
  })
})
