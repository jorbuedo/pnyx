import {describe, expect, it} from 'vitest'

import {addressForGroup} from './midnight-unshielded-address'

const A = 'group-7a1d3e33d2a6ead9bcda53dfb88cbf33'
const B = 'group-079851260033977a0961e83d89f4b70c'
const ADDR_A = 'mn_addr_preprod1abandon12'

describe('addressForGroup', () => {
  it('answers the address when it belongs to the group being asked about', () => {
    expect(addressForGroup({groupId: A, address: ADDR_A}, A)).toBe(ADDR_A)
  })

  it('answers undefined for another group — never the other wallet address', () => {
    // ⚠️ The defect this exists for, seen on device switching Abandon 12 → Pnyx sponsor. The hook held
    // a bare address and cleared it only on *deselect*, so through a switch it reported the previous
    // wallet's address while `groupId` had already moved. Consumers pair the two, and the unshielded
    // one-shot writes its cache by `groupId` — so Abandon 12's 8 UTxOs and 38 activity rows were
    // written under the sponsor's key.
    expect(addressForGroup({groupId: A, address: ADDR_A}, B)).toBeUndefined()
  })

  it('answers undefined before anything has resolved', () => {
    expect(addressForGroup(undefined, A)).toBeUndefined()
  })

  it('answers undefined when no group is selected, even holding a resolved address', () => {
    expect(addressForGroup({groupId: A, address: ADDR_A}, undefined)).toBeUndefined()
  })

  it('carries a genuine "this wallet has none" through, rather than turning it into "not yet"', () => {
    // Hardware, read-only and shared wallets never derived a Midnight address. That is an answer, and
    // it has to survive the stamp — otherwise those wallets look permanently pending.
    expect(addressForGroup({groupId: A, address: undefined}, A)).toBeUndefined()
  })
})
