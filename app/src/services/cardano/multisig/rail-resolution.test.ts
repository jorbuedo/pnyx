import {Bech32, ScriptHex} from '@evolution-sdk/review/Brands'
import {describe, expect, it} from 'vitest'
import type {DiscoveredAddress, Discovery, SharedUtxo} from './discovery'
import {otherAddressesOf, planSharedRail, type SharedRailPlan} from './rail-resolution'

/** Real addresses by key index: the brands check now, and both helpers must agree. */
const ADDRESS_AT = [
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
  'addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw',
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
] as const
const addressAt = (index: number): string => ADDRESS_AT[index] ?? ADDRESS_AT[2]

const utxo = (coin: bigint, keyIndex: number): SharedUtxo => ({
  txHash: 'aa'.repeat(32),
  index: 0,
  coin,
  assets: [],
  keyIndex,
  addressBech32: addressAt(keyIndex),
})

const at = (index: number, coins: readonly bigint[] = []): DiscoveredAddress => ({
  scripts: {
    paymentScriptHex: ScriptHex('82'),
    stakingScriptHex: ScriptHex('82'),
    paymentScriptHashHex: `${index}`.repeat(56).slice(0, 56),
    stakingScriptHashHex: '99'.repeat(28),
    addressBech32: Bech32(addressAt(index)),
    rewardAddressBech32: Bech32('stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl'),
    index,
  },
  utxos: coins.map((c) => utxo(c, index)),
  used: coins.length > 0,
})

const discovery = (addresses: readonly DiscoveredAddress[], truncated = false): Discovery => {
  const utxos = addresses.flatMap((a) => a.utxos)
  return {
    addresses,
    utxos,
    coin: utxos.reduce((s, u) => s + u.coin, 0n),
    assets: [],
    nextUnusedIndex: addresses.find((a) => !a.used)?.scripts.index ?? addresses.length,
    truncated,
  }
}

describe('planSharedRail', () => {
  it('spends from the funded index, not from index 0', () => {
    // Index 0 is empty here. Pinning the rail to it would show a balance the
    // wallet cannot touch: a witness at index 0 authorises nothing at index 2.
    const plan = planSharedRail(discovery([at(0), at(1), at(2, [7_000_000n])]))
    expect(plan?.keyIndex).toBe(2)
    expect(plan?.primaryAddress).toBe(addressAt(2))
  })

  it('picks the index holding the most, so the largest spend is possible', () => {
    const plan = planSharedRail(discovery([at(0, [1_000_000n]), at(1, [9_000_000n])]))
    expect(plan?.keyIndex).toBe(1)
  })

  it('breaks a tie towards the lower index', () => {
    const plan = planSharedRail(discovery([at(0, [5_000_000n]), at(3, [5_000_000n])]))
    expect(plan?.keyIndex).toBe(0)
  })

  it('sums a multi-UTxO index rather than comparing single coins', () => {
    // Index 0 holds more in total; index 1 holds the single biggest UTxO.
    const plan = planSharedRail(discovery([at(0, [4_000_000n, 4_000_000n]), at(1, [6_000_000n])]))
    expect(plan?.keyIndex).toBe(0)
  })

  it('takes the first unused address for an empty wallet — where its first deposit is asked for', () => {
    const plan = planSharedRail(discovery([at(0), at(1), at(2)]))
    expect(plan?.keyIndex).toBe(0)
    expect(plan?.spansIndexes).toBe(false)
  })

  it('syncs the other funded addresses, so the balance is the whole wallet', () => {
    const plan = planSharedRail(discovery([at(0, [1n]), at(1, [9n]), at(2)]))
    expect(otherAddressesOf(plan as SharedRailPlan)).toEqual([addressAt(0)])
  })

  it('carries the other indexes, not only their addresses', () => {
    // The index is what the account's authority needs: it compiles that index's
    // script and derives our key at it. An address alone cannot say which index
    // it came from — a script address is a hash.
    const plan = planSharedRail(discovery([at(0, [1n]), at(1, [9n]), at(2)]))
    expect(plan?.others).toEqual([{keyIndex: 0, addressBech32: addressAt(0)}])
  })

  it('leaves empty addresses out of the sync — a call each, and nothing to report', () => {
    const plan = planSharedRail(discovery([at(0, [9n]), at(1), at(2), at(3)]))
    expect(plan?.others).toEqual([])
  })

  it('says when funds span indexes, which decides how many signatures are owed', () => {
    expect(planSharedRail(discovery([at(0, [1n]), at(2, [1n])]))?.spansIndexes).toBe(true)
    expect(planSharedRail(discovery([at(0, [1n])]))?.spansIndexes).toBe(false)
  })

  it('carries a truncated scan through — the balance below it is a floor', () => {
    expect(planSharedRail(discovery([at(0, [1n])], true))?.truncated).toBe(true)
  })

  it('is null when the scan produced nothing, rather than inventing index 0', () => {
    expect(planSharedRail(discovery([]))).toBeNull()
  })
})
