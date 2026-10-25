// identity.compact end to end against real witnesses: publish → name → card write, read, clear.
//
// The properties worth proving are the ones the shared registry could not hold, plus the one it got
// wrong: a contract per identity means `requireOwner` is the *whole* authorisation model, and
// `publishRow` must be unable to touch naming (the predecessor's row publisher took a whole row and
// wrote it verbatim, so it could set a handle the naming circuits would have refused).
//
// It doubles as the TS ↔ Compact edge for `card.ts`: the rows below are produced by that codec and
// read back through it, so a drifted length prefix or continuation flag fails here as a card the
// contract stored and the client cannot read.

import {bytes32} from '@pnyx/contract-client/bytes'
import {CardKind, ROW_VALUE_BYTES, cardBatches, cardWriteSet, decodeCard, encodeCard, encodeChainAddress, type CardEntry, type CardRowBytes} from '@pnyx/contract-client/card'
import {identityCommitment, pad32} from '@pnyx/contract-client/derivations'
import {createIdentitySimulator, type IdentitySimulator} from '@pnyx/contract-client/identity-simulator'
import type {IdentityPrivateState} from '@pnyx/contract-client/identity-witnesses'
import {describe, expect, it} from 'vitest'

const alice: IdentityPrivateState = {identitySk: bytes32(1)}
const mallory: IdentityPrivateState = {identitySk: bytes32(2)}
const aliceC = identityCommitment(alice.identitySk)

const ANCHOR = bytes32(7)
const AUTH_PUB = bytes32(8)

/** A real preprod shielded address — 132 bytes, the longest single-row value the card must carry. */
const MIDNIGHT_ADDR =
  'mn_shield-addr_preprod1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd'

/** The `did:midnight:offchain` long form at its schema maximum — 951 bytes, so it spans three rows. */
const DID_LONG = `did:midnight:offchain:${'a'.repeat(64)}:${'Q'.repeat(864)}`

const aliceIdentity = (): IdentitySimulator => createIdentitySimulator(alice, aliceC)

/** Apply a write set through `setRows`, four slots per call, as the app will. */
const saveCard = (sim: IdentitySimulator, writeSet: readonly CardRowBytes[]): number => {
  const batches = cardBatches(writeSet)
  for (const batch of batches) {
    sim.call(
      'setRows',
      batch.map((r) => BigInt(r.slot)),
      batch.map((r) => ({kind: BigInt(r.kind), value: r.value})),
    )
  }
  return batches.length
}

const readCard = (sim: IdentitySimulator): CardRowBytes[] => {
  const rows: CardRowBytes[] = []
  for (const [slot, row] of sim.getLedger().card) {
    rows.push({slot: Number(slot), kind: Number(row.kind), value: row.value})
  }
  return rows
}

describe('identity row', () => {
  it('publishes and rotates the two keys', () => {
    const sim = aliceIdentity()
    expect(sim.getLedger().id).toEqual(aliceC)
    sim.call('publishRow', ANCHOR, AUTH_PUB)
    expect(sim.getLedger().anchor).toEqual(ANCHOR)
    expect(sim.getLedger().authPub).toEqual(AUTH_PUB)

    const rotated = bytes32(9)
    sim.call('publishRow', rotated, AUTH_PUB)
    expect(sim.getLedger().anchor).toEqual(rotated)
  })

  it('cannot be written by another identity — the whole authorisation model', () => {
    const sim = aliceIdentity()
    sim.setPrivateState(mallory)
    expect(() => sim.call('publishRow', ANCHOR, AUTH_PUB)).toThrow(/not your identity/)
    expect(() => sim.call('setPrimaryName', pad32('mallory'))).toThrow(/not your identity/)
    expect(() => sim.call('setRow', 0n, BigInt(CardKind.Website), encodeCard([{kind: CardKind.Website, value: 'https://evil'}])[0]!.value)).toThrow(
      /not your identity/,
    )
  })

  it('sets and clears the primary name', () => {
    const sim = aliceIdentity()
    sim.call('publishRow', ANCHOR, AUTH_PUB)
    sim.call('setPrimaryName', pad32('jordi'))
    expect(sim.getLedger().primaryName).toEqual(pad32('jordi'))
    sim.call('setPrimaryName', pad32(''))
    expect(sim.getLedger().primaryName).toEqual(pad32(''))
  })

  it('publishRow cannot touch the primary name — the predecessor contract could', () => {
    const sim = aliceIdentity()
    sim.call('setPrimaryName', pad32('jordi'))
    sim.call('publishRow', bytes32(21), bytes32(22))
    expect(sim.getLedger().primaryName).toEqual(pad32('jordi'))
  })
})

describe('contact card', () => {
  const entries: CardEntry[] = [
    {kind: CardKind.ChainAddress, value: encodeChainAddress('midnight:undeployed', MIDNIGHT_ADDR)},
    {kind: CardKind.ChainAddress, value: encodeChainAddress('cardano:preprod', 'addr1q8g3dv6ptkgsafh7k5muggrvfde2szzmc2m8w4dt6zqnfa2rnfxqm3xzu9nsw0y5xrcvpmvj0hnzrqqz7hkxrqx6kkzs4pnxvz')},
    {kind: CardKind.Website, value: 'https://pnyx.app/jordi'},
    {kind: CardKind.Email, value: 'jordi@example.com'},
  ]

  it('round-trips through the contract, not just through the codec', () => {
    const sim = aliceIdentity()
    saveCard(sim, cardWriteSet(entries, 0))
    const {entries: back, defects} = decodeCard(readCard(sim))
    expect(defects).toEqual([])
    expect(back).toEqual(entries)
  })

  it('saves four rows in one proof', () => {
    const sim = aliceIdentity()
    expect(saveCard(sim, cardWriteSet(entries, 0))).toBe(1)
  })

  it('stores a chunked long-form DID across three slots and reads it back whole', () => {
    const sim = aliceIdentity()
    const withDid: CardEntry[] = [{kind: CardKind.Did, value: DID_LONG}, {kind: CardKind.Email, value: 'a@b.co'}]
    saveCard(sim, cardWriteSet(withDid, 0))
    expect(Number(sim.getLedger().card.size())).toBe(4)
    const {entries: back, defects} = decodeCard(readCard(sim))
    expect(defects).toEqual([])
    expect(back).toEqual(withDid)
  })

  it('writes and clears a single row', () => {
    const sim = aliceIdentity()
    const [row] = encodeCard([{kind: CardKind.Email, value: 'a@b.co'}])
    sim.call('setRow', 0n, BigInt(row!.kind), row!.value)
    expect(sim.getLedger().card.member(0n)).toBe(true)
    sim.call('setRow', 0n, 0n, new Uint8Array(ROW_VALUE_BYTES))
    expect(sim.getLedger().card.member(0n)).toBe(false)
  })

  it('refuses to clear a row that is not there, rather than reporting a removal of nothing', () => {
    const sim = aliceIdentity()
    expect(() => sim.call('setRow', 5n, 0n, new Uint8Array(ROW_VALUE_BYTES))).toThrow(/no such row/)
  })

  it('refuses a slot past the cap, from either entry point', () => {
    const sim = aliceIdentity()
    const [row] = encodeCard([{kind: CardKind.Note, value: 'x'}])
    expect(() => sim.call('setRow', 64n, BigInt(row!.kind), row!.value)).toThrow(/slot out of range/)
    expect(() =>
      sim.call(
        'setRows',
        [64n, 0n, 1n, 2n],
        [0, 1, 2, 3].map(() => ({kind: BigInt(row!.kind), value: row!.value})),
      ),
    ).toThrow(/slot out of range/)
  })

  it('leaves no orphaned rows when the card shrinks', () => {
    const sim = aliceIdentity()
    const before = cardWriteSet(entries, 0)
    saveCard(sim, before)
    expect(Number(sim.getLedger().card.size())).toBe(4)

    const shrunk: CardEntry[] = [{kind: CardKind.Website, value: 'https://pnyx.app'}]
    saveCard(sim, cardWriteSet(shrunk, encodeCard(entries).length))
    expect(Number(sim.getLedger().card.size())).toBe(1)
    const {entries: back, defects} = decodeCard(readCard(sim))
    expect(defects).toEqual([])
    expect(back).toEqual(shrunk)
  })

  it('leaves no orphaned rows when a chunked value is replaced by a short one', () => {
    // The case a naive save gets wrong: three slots of DID become one slot of website, and slots 1
    // and 2 must go or the card reads as a dangling continuation.
    const sim = aliceIdentity()
    const long: CardEntry[] = [{kind: CardKind.Did, value: DID_LONG}]
    saveCard(sim, cardWriteSet(long, 0))
    expect(Number(sim.getLedger().card.size())).toBe(3)

    const short: CardEntry[] = [{kind: CardKind.Website, value: 'https://pnyx.app'}]
    saveCard(sim, cardWriteSet(short, encodeCard(long).length))
    expect(Number(sim.getLedger().card.size())).toBe(1)
    expect(decodeCard(readCard(sim))).toEqual({entries: short, defects: []})
  })

  it('a batch clearing an already-empty slot is a no-op, unlike setRow', () => {
    const sim = aliceIdentity()
    const empty = {kind: 0n, value: new Uint8Array(ROW_VALUE_BYTES)}
    expect(() => sim.call('setRows', [0n, 1n, 2n, 3n], [empty, empty, empty, empty])).not.toThrow()
    expect(sim.getLedger().card.isEmpty()).toBe(true)
  })

  it('stores an encrypted row as opaque bytes and returns the flag intact', () => {
    const sim = aliceIdentity()
    const sealed: CardEntry[] = [{kind: CardKind.ChainAddress, value: 'AAAA'.repeat(20), encrypted: true}]
    saveCard(sim, cardWriteSet(sealed, 0))
    const {entries: back, defects} = decodeCard(readCard(sim))
    expect(defects).toEqual([])
    expect(back).toEqual(sealed)
  })
})
