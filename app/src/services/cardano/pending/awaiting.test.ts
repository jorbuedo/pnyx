import {describe, expect, it} from 'vitest'
import type {EnvelopeSigner, TxEnvelope} from '../cosign/types'
import type {LocalWallet} from '../multiparty/local-signers'
import {awaitingHere} from './awaiting'

const ALICE_KEY = 'aa'.repeat(28)
const BOB_KEY = 'bb'.repeat(28)
const STRANGER_KEY = 'cc'.repeat(28)

const signer = (id: string, keyHashHex: string, signed: boolean): EnvelopeSigner => ({
  id,
  name: id,
  keyHashHex,
  signed,
})

const envelope = (kind: TxEnvelope['kind'], signers: readonly EnvelopeSigner[]): TxEnvelope =>
  ({
    version: 1,
    chainId: 'cardano:preprod',
    createdAt: '2026-08-10T00:00:00.000Z',
    createdBy: 'test',
    kind,
    bodyHex: 'aa',
    nativeScriptHexes: [],
    networkId: 0,
    accountIndex: 0,
    signers,
    witnesses: [],
  }) as TxEnvelope

const wallet = (groupId: string, keys: readonly string[], canSign = true): LocalWallet => ({
  groupId,
  name: groupId,
  paymentKeyHashes: keys,
  canSign,
})

describe('awaitingHere', () => {
  /**
   * "All of my rows are signed" is true both of a transaction still waiting on somebody
   * else and of one that is complete. Reading the second as the first tells the one person
   * who can finish it to go and wait.
   */
  it('says a gathered transaction is waiting to be submitted, not for signers', () => {
    const result = awaitingHere(envelope('multiparty', [signer('a', ALICE_KEY, true), signer('b', BOB_KEY, true)]), [
      wallet('alice', [ALICE_KEY]),
    ])
    expect(result.kind).toBe('ready')
  })

  it('says ready for a gathered multisig too, rather than staying silent', () => {
    const env = {...envelope('multisig', [signer('a', ALICE_KEY, true)]), nativeScriptHexes: []} as TxEnvelope
    expect(awaitingHere(env, []).kind).toBe('ready')
  })

  it('names the wallet that still owes a signature', () => {
    const result = awaitingHere(envelope('multiparty', [signer('a', ALICE_KEY, true), signer('b', BOB_KEY, false)]), [
      wallet('alice', [ALICE_KEY]),
      wallet('bob', [BOB_KEY]),
    ])
    expect(result).toEqual({kind: 'you', wallets: [{groupId: 'bob', name: 'bob'}]})
  })

  it('says others once every row this device can answer is signed', () => {
    const result = awaitingHere(envelope('multiparty', [signer('a', ALICE_KEY, true), signer('b', BOB_KEY, false)]), [
      wallet('alice', [ALICE_KEY]),
    ])
    expect(result.kind).toBe('others')
  })

  /**
   * The distinction that keeps the inbox honest. "Someone else is signing" and "we cannot
   * tell" are different sentences, and rendering the second as the first is a guess.
   */
  it('is unknown when the roster names nobody on this device', () => {
    const result = awaitingHere(envelope('multiparty', [signer('x', STRANGER_KEY, false)]), [
      wallet('alice', [ALICE_KEY]),
    ])
    expect(result.kind).toBe('unknown')
  })

  // A multisig roster names CIP-1854 co-signer key hashes, which no ordinary wallet holds.
  // Its envelope is filed under the shared wallet itself, so its group is already correct.
  it('is unknown for a multisig envelope rather than guessing from payment keys', () => {
    const result = awaitingHere(envelope('multisig', [signer('a', ALICE_KEY, false)]), [wallet('alice', [ALICE_KEY])])
    expect(result.kind).toBe('unknown')
  })

  // Alice watching Bob read-only holds his key hashes and matches his row perfectly.
  it('never names a watch-only wallet, which can recognise a row and never satisfy it', () => {
    const result = awaitingHere(envelope('multiparty', [signer('b', BOB_KEY, false)]), [
      wallet('watcher', [BOB_KEY], false),
    ])
    expect(result.kind).toBe('unknown')
  })

  it('lists a wallet once even when it owes a witness per key', () => {
    const result = awaitingHere(
      envelope('multiparty', [signer('b', BOB_KEY, false), signer('b2', STRANGER_KEY, false)]),
      [wallet('bob', [BOB_KEY, STRANGER_KEY])],
    )
    expect(result).toEqual({kind: 'you', wallets: [{groupId: 'bob', name: 'bob'}]})
  })
})
