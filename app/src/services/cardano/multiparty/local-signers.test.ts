import {describe, expect, it} from 'vitest'
import type {EnvelopeSigner} from '../cosign/types'
import {type LocalWallet, localMultipartySignersOf, outstandingMultipartySigners} from './local-signers'

const HASH_ALICE = '1f30415263748596a7b8c9daebfc0d1e2f405162738495a6b7c8d9ea'
const HASH_BOB = '3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f708192a3b4c5d6e7f809'
const HASH_CAROL = '5d6e7f90a1b2c3d4e5f60718293a4b5c6d7e8fa0b1c2d3e4f5061728'

const signer = (id: string, name: string, keyHashHex: string, signed = false): EnvelopeSigner => ({
  id,
  name,
  keyHashHex,
  signed,
})

const roster: readonly EnvelopeSigner[] = [
  signer('alice', 'Alice', HASH_ALICE, true),
  signer('bob', 'Bob', HASH_BOB),
  signer('carol', 'Carol', HASH_CAROL),
]

const wallet = (over: Partial<LocalWallet> & {groupId: string}): LocalWallet => ({
  name: over.name ?? over.groupId,
  paymentKeyHashes: over.paymentKeyHashes ?? [],
  canSign: over.canSign ?? true,
  groupId: over.groupId,
})

describe('localMultipartySignersOf', () => {
  it('finds the row this device holds the key for', () => {
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-bob', name: "Bob's wallet", paymentKeyHashes: [HASH_BOB]}),
    ])
    expect(local).toEqual([
      {
        groupId: 'g-bob',
        walletName: "Bob's wallet",
        signerId: 'bob',
        signerName: 'Bob',
        keyHashHex: HASH_BOB,
        signed: false,
      },
    ])
  })

  it('never offers a row a read-only wallet merely recognises', () => {
    // Alice watches Bob read-only, so her device holds his payment key hashes and matches
    // his roster row perfectly. Offering her the signature would offer something no key on
    // her device can produce.
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-alice', paymentKeyHashes: [HASH_ALICE]}),
      wallet({groupId: 'g-bob-watched', paymentKeyHashes: [HASH_BOB], canSign: false}),
    ])
    expect(local.map((s) => s.signerId)).toEqual(['alice'])
  })

  it('matches case-insensitively, since a key hash is hex from two sources', () => {
    const local = localMultipartySignersOf(
      [signer('bob', 'Bob', HASH_BOB.toUpperCase())],
      [wallet({groupId: 'g-bob', paymentKeyHashes: [HASH_BOB]})],
    )
    expect(local).toHaveLength(1)
  })

  it('returns nothing when this device is only a bystander', () => {
    expect(
      localMultipartySignersOf(roster, [wallet({groupId: 'g-dave', paymentKeyHashes: ['ab'.repeat(28)]})]),
    ).toEqual([])
  })

  it('finds several rows when one device holds several parties', () => {
    // A test device, or someone genuinely co-funding from two of their own wallets. Both
    // signatures are owed and both must be offered.
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-bob', paymentKeyHashes: [HASH_BOB]}),
      wallet({groupId: 'g-carol', paymentKeyHashes: [HASH_CAROL]}),
    ])
    expect(local.map((s) => s.signerId)).toEqual(['bob', 'carol'])
  })

  it('keeps roster order, not wallet-list order', () => {
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-carol', paymentKeyHashes: [HASH_CAROL]}),
      wallet({groupId: 'g-alice', paymentKeyHashes: [HASH_ALICE]}),
    ])
    expect(local.map((s) => s.signerId)).toEqual(['alice', 'carol'])
  })

  it('does not double-count one key imported under two groups', () => {
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-bob', paymentKeyHashes: [HASH_BOB]}),
      wallet({groupId: 'g-bob-again', paymentKeyHashes: [HASH_BOB]}),
    ])
    expect(local).toHaveLength(1)
    expect(local[0]?.groupId).toBe('g-bob')
  })

  it('reports a row this device already signed, so the caller can say so', () => {
    const local = localMultipartySignersOf(roster, [wallet({groupId: 'g-alice', paymentKeyHashes: [HASH_ALICE]})])
    expect(local[0]?.signed).toBe(true)
  })
})

describe('outstandingMultipartySigners', () => {
  it('drops the rows already signed', () => {
    const local = localMultipartySignersOf(roster, [
      wallet({groupId: 'g-alice', paymentKeyHashes: [HASH_ALICE]}),
      wallet({groupId: 'g-bob', paymentKeyHashes: [HASH_BOB]}),
    ])
    expect(outstandingMultipartySigners(local).map((s) => s.signerId)).toEqual(['bob'])
  })

  it('is empty once this device has given everything it owes', () => {
    const local = localMultipartySignersOf(
      [signer('alice', 'Alice', HASH_ALICE, true)],
      [wallet({groupId: 'g-alice', paymentKeyHashes: [HASH_ALICE]})],
    )
    expect(outstandingMultipartySigners(local)).toEqual([])
  })
})
