import {decodeCardanoSignRequest} from '@pnyx/ur'
import {describe, expect, it} from 'vitest'

import {buildKeystoneSignRequest, keypathFromString} from './keystone-sign-request'

const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/0'/2/0"
const PAYMENT_ADDRESS = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const STAKE_ADDRESS = 'stake_test1uqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const OUR_KEY_HASH = 'aa'.repeat(28)
const THEIR_KEY_HASH = 'bb'.repeat(28)

const base = {
  transactionCbor: new Uint8Array([0x84, 0xa0]),
  txHashHex: 'c'.repeat(64),
  signingPaths: [PAYMENT_PATH],
  requiredKeyHashes: [],
  ownedKeyHashes: new Map([[OUR_KEY_HASH, STAKE_PATH]]),
  addressForPath: new Map([
    [PAYMENT_PATH, PAYMENT_ADDRESS],
    [STAKE_PATH, STAKE_ADDRESS],
  ]),
  inputs: [
    {
      transactionHash: new Uint8Array(32).fill(9),
      index: 1,
      amount: '2000000',
      address: PAYMENT_ADDRESS,
      path: PAYMENT_PATH,
    },
  ],
  masterFingerprint: 0x1250b6bc,
}

describe('keypathFromString', () => {
  it('splits hardened components the way the wire format wants them', () => {
    expect(keypathFromString(PAYMENT_PATH).components).toEqual([
      {index: 1852, hardened: true},
      {index: 1815, hardened: true},
      {index: 0, hardened: true},
      {index: 0, hardened: false},
      {index: 0, hardened: false},
    ])
  })

  it('carries the master fingerprint when given one, and omits it otherwise', () => {
    expect(keypathFromString(PAYMENT_PATH, 7).sourceFingerprint).toBe(7)
    expect(keypathFromString(PAYMENT_PATH).sourceFingerprint).toBeUndefined()
  })

  // An empty path would reach the UR writer, which refuses it — but failing here names the input
  // rather than the encoding, and the caller can say which input had no path.
  it('refuses a path with nothing in it', () => {
    expect(() => keypathFromString('m/')).toThrow(/not a derivation path/)
    expect(() => keypathFromString("m/1852'/x")).toThrow(/component/)
  })
})

describe('a transaction the device can parse', () => {
  it('is built as a body request, with our inputs and their paths', () => {
    const plan = buildKeystoneSignRequest({...base, shape: {kind: 'body'}, origin: 'pnyx'})
    expect(plan.urType).toBe('cardano-sign-request')
    expect(plan.hashOnlyBecause).toBeUndefined()

    const decoded = decodeCardanoSignRequest(plan.cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.utxos).toHaveLength(1)
    expect(decoded.value.utxos[0]?.amount).toBe('2000000')
    expect(decoded.value.utxos[0]?.address).toBe(PAYMENT_ADDRESS)
    expect(decoded.value.utxos[0]?.keyPath.sourceFingerprint).toBe(base.masterFingerprint)
    expect(decoded.value.origin).toBe('pnyx')
  })
})

describe('extraSigners', () => {
  // ⚠️ **The audit finding.** Gero pushes the stake key for every `requiredExtraSignatures` entry
  // without checking the hash matches — telling a device we can sign for a credential we may not hold.
  it('claims only the required hashes that resolve to a key we hold', () => {
    const plan = buildKeystoneSignRequest({
      ...base,
      shape: {kind: 'body'},
      requiredKeyHashes: [OUR_KEY_HASH, THEIR_KEY_HASH],
    })
    const decoded = decodeCardanoSignRequest(plan.cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.extraSigners).toHaveLength(1)
    expect(Buffer.from(decoded.value.extraSigners[0]?.keyHash ?? new Uint8Array()).toString('hex')).toBe(OUR_KEY_HASH)
  })

  it('claims nothing when no required hash is ours — a co-signer signs their own side', () => {
    const plan = buildKeystoneSignRequest({...base, shape: {kind: 'body'}, requiredKeyHashes: [THEIR_KEY_HASH]})
    const decoded = decodeCardanoSignRequest(plan.cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.extraSigners).toHaveLength(0)
  })

  // ⚠️ Bytes on the wire. A 28-byte hash sent as its 56-character text is a different value, and the
  // device would either refuse or match the wrong key.
  it('sends a key hash as 28 bytes, not as its hex text', () => {
    const plan = buildKeystoneSignRequest({...base, shape: {kind: 'body'}, requiredKeyHashes: [OUR_KEY_HASH]})
    const decoded = decodeCardanoSignRequest(plan.cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.extraSigners[0]?.keyHash).toHaveLength(28)
  })
})

describe('a transaction the device cannot parse', () => {
  const shape = {kind: 'hash', reason: 'this transaction already carries witnesses or scripts — hash only'} as const

  it('is built as a hash request, carrying the reason for the review screen', () => {
    const plan = buildKeystoneSignRequest({...base, shape})
    expect(plan.urType).toBe('cardano-sign-tx-hash-request')
    // ⚠️ Dropping this is how hash-signing becomes blind signing: it is the only thing that tells the
    // user the device will show them less than the phone just did.
    expect(plan.hashOnlyBecause).toBe(shape.reason)
  })

  // The device pairs paths and addresses positionally, so a missing address would label one key with
  // another's — refusing beats emitting a request whose display is wrong.
  it('refuses when a signing path has no address to show', () => {
    expect(() =>
      buildKeystoneSignRequest({...base, shape, signingPaths: [PAYMENT_PATH, "m/1852'/1815'/0'/0/9"]}),
    ).toThrow(/no address resolved/)
  })
})
