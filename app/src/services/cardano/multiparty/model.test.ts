import {describe, expect, it} from 'vitest'
import {type ContributingWallet, extractRequiredSigners} from './model'

/** A base address over a given payment credential. Stake is irrelevant to the roster. */
const addressOf = (paymentCred: string) => `00${paymentCred}${'99'.repeat(28)}`

const ALICE_KEY_A = '11'.repeat(28)
const ALICE_KEY_B = '12'.repeat(28)
const BOB_KEY = '22'.repeat(28)
const SCRIPT_CRED = '33'.repeat(28)

const alice = (hashes: readonly string[]): ContributingWallet => ({
  walletId: 'alice',
  name: 'Alice',
  paymentKeyHashes: hashes,
  isSelf: true,
})
const bob = (hashes: readonly string[]): ContributingWallet => ({
  walletId: 'bob',
  name: 'Bob',
  paymentKeyHashes: hashes,
})

describe('extractRequiredSigners', () => {
  it('names one signer per contributing wallet when each spends from one key', () => {
    const signers = extractRequiredSigners(
      [{addressHex: addressOf(ALICE_KEY_A)}, {addressHex: addressOf(BOB_KEY)}],
      [alice([ALICE_KEY_A]), bob([BOB_KEY])],
    )
    expect(signers.map((s) => s.name)).toEqual(['Alice', 'Bob'])
  })

  /**
   * The count the ledger actually enforces.
   *
   * A gap-scanned wallet's coins routinely sit on several of its own addresses, and each
   * address's key owes its own vkey witness. One row per wallet displayed "1 of 1" for a
   * party owing two signatures, and `meetsQuorum` — which counts signed rows — agreed with
   * it.
   */
  it('owes one signature per key a wallet spends from, not one per wallet', () => {
    const signers = extractRequiredSigners(
      [{addressHex: addressOf(ALICE_KEY_A)}, {addressHex: addressOf(ALICE_KEY_B)}, {addressHex: addressOf(BOB_KEY)}],
      [alice([ALICE_KEY_A, ALICE_KEY_B]), bob([BOB_KEY])],
    )
    expect(signers).toHaveLength(3)
    expect(signers.filter((s) => s.id === 'alice').map((s) => s.keyHashHex)).toEqual([ALICE_KEY_A, ALICE_KEY_B])
  })

  it('ignores a key the wallet holds but the body does not spend from', () => {
    const signers = extractRequiredSigners(
      [{addressHex: addressOf(ALICE_KEY_A)}, {addressHex: addressOf(BOB_KEY)}],
      [alice([ALICE_KEY_A, ALICE_KEY_B]), bob([BOB_KEY])],
    )
    expect(signers.filter((s) => s.id === 'alice')).toHaveLength(1)
  })

  /** One key imported under two groups owes one witness; two rows would never be satisfied. */
  it('attributes a shared key hash to one wallet only', () => {
    const signers = extractRequiredSigners([{addressHex: addressOf(BOB_KEY)}], [alice([BOB_KEY]), bob([BOB_KEY])])
    expect(signers).toHaveLength(1)
    expect(signers[0]?.id).toBe('alice')
  })

  it('marks the composer row as self so the screen can offer its signature', () => {
    const signers = extractRequiredSigners(
      [{addressHex: addressOf(ALICE_KEY_A)}, {addressHex: addressOf(BOB_KEY)}],
      [alice([ALICE_KEY_A]), bob([BOB_KEY])],
    )
    expect(signers.find((s) => s.id === 'alice')?.isSelf).toBe(true)
    expect(signers.find((s) => s.id === 'bob')?.isSelf).toBeUndefined()
  })

  it('matches irrespective of hex case', () => {
    const signers = extractRequiredSigners(
      [{addressHex: addressOf(ALICE_KEY_A).toUpperCase()}],
      [alice([ALICE_KEY_A.toUpperCase()])],
    )
    expect(signers).toHaveLength(1)
  })

  /** A script credential is not a key and cannot produce a vkey witness. */
  it('never names a script payment credential as a signer', () => {
    const signers = extractRequiredSigners([{addressHex: `10${SCRIPT_CRED}${'99'.repeat(28)}`}], [alice([SCRIPT_CRED])])
    expect(signers).toEqual([])
  })
})
