import type {UTxO} from '@evolution-sdk/evolution'
import {hex} from '@pnyx/crypto'
import {encodeCardanoSignRequest, UR_TYPE_SIGN_REQUEST, UR_TYPE_SIGN_TX_HASH_REQUEST} from '@pnyx/ur'
import {describe, expect, it} from 'vitest'
import {testUtxo} from '../cardano/test-utxo'
import {decideSignRequest, networkMismatch, networkOfAddress} from './sign-request-review'

/** Cardano's own numbering: 0 testnet. Every fixture address here is `addr_test1…`. */
const TESTNET = 0

const HASH = new Uint8Array(32).fill(0x11)
/** The abandon-preprod account-0 base address, so the fixture matches a wallet we actually hold. */
const ADDR =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'

const keyPath = {
  components: [
    {index: 1852, hardened: true},
    {index: 1815, hardened: true},
    {index: 0, hardened: true},
    {index: 0, hardened: false},
    {index: 0, hardened: false},
  ],
}

/** A stand-in transaction body — `{0: 1, 2: 3}`. The decision slices it out; it never reads it. */
const BODY = Uint8Array.from([0xa2, 0x00, 0x01, 0x02, 0x03])
/** What `signData` actually carries: the whole transaction `[body, {}, true, null]`. */
const FULL_TX = Uint8Array.from([0x84, ...BODY, 0xa0, 0xf5, 0xf6])

const requestUr = (over: {amount?: string; address?: string; origin?: string; signData?: Uint8Array} = {}) => ({
  type: UR_TYPE_SIGN_REQUEST,
  cbor: encodeCardanoSignRequest({
    signData: over.signData ?? FULL_TX,
    utxos: [
      {
        transactionHash: HASH,
        index: 0,
        amount: over.amount ?? '10405672323',
        keyPath,
        address: over.address ?? ADDR,
      },
    ],
    extraSigners: [],
    ...(over.origin === undefined ? {} : {origin: over.origin}),
  }),
})

const synced: UTxO.UTxO[] = [testUtxo({txHash: 0x11, address: ADDR, lovelace: 10_405_672_323n})]

describe('a request we can honour', () => {
  it('is reviewable with every input verified', () => {
    const decision = decideSignRequest(requestUr(), synced, TESTNET)
    expect(decision.kind).toBe('reviewable')
    if (decision.kind !== 'reviewable') return
    expect(decision.unknownCount).toBe(0)
    expect(decision.inputs[0]?.trust).toEqual({kind: 'verified'})
  })

  // Surfaced separately from the request body so a screen has to opt into showing it, and can
  // only show it labelled.
  it('exposes origin as explicitly unverified', () => {
    const decision = decideSignRequest(requestUr({origin: 'totally-legit-wallet'}), synced, TESTNET)
    if (decision.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(decision.unverifiedOrigin).toBe('totally-legit-wallet')
  })

  it('omits origin when the request sent none', () => {
    const decision = decideSignRequest(requestUr(), synced, TESTNET)
    if (decision.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(decision.unverifiedOrigin).toBeUndefined()
  })

  it('counts inputs it could not confirm', () => {
    const decision = decideSignRequest(requestUr(), [], TESTNET)
    if (decision.kind !== 'reviewable') throw new Error('expected reviewable')
    expect(decision.unknownCount).toBe(1)
    expect(decision.inputs[0]?.trust.kind).toBe('unknown')
  })
})

/**
 * `signData` is the whole unsigned transaction, which is what Eternl sends and what the review
 * and the witness both need the *body* of. Reviewing or signing the outer array would render the
 * wrong numbers and hash the wrong message.
 */
describe('the transaction body a request carries', () => {
  it('is sliced out of the whole transaction, byte for byte', () => {
    const decision = decideSignRequest(requestUr(), synced, TESTNET)
    if (decision.kind !== 'reviewable') throw new Error(`expected reviewable, got ${decision.kind}`)
    expect(decision.bodyHex).toBe(hex.encode(BODY))
  })

  it('is taken as-is when a counterparty sends the body alone', () => {
    const decision = decideSignRequest(requestUr({signData: BODY}), synced, TESTNET)
    if (decision.kind !== 'reviewable') throw new Error(`expected reviewable, got ${decision.kind}`)
    expect(decision.bodyHex).toBe(hex.encode(BODY))
  })

  it('refuses signData that is not a transaction at all', () => {
    // A byte string: neither the array a transaction is nor the map a body is.
    const decision = decideSignRequest(requestUr({signData: Uint8Array.from([0x43, 1, 2, 3])}), synced, TESTNET)
    expect(decision).toMatchObject({kind: 'refused', reason: 'malformed'})
  })

  // The shape that produced the field's original misreading: a map header is not a body.
  it('refuses a body-shaped payload that does not decode', () => {
    const decision = decideSignRequest(requestUr({signData: Uint8Array.from([0xa4, 0x00, 0x81])}), synced, TESTNET)
    expect(decision).toMatchObject({kind: 'refused', reason: 'malformed'})
  })

  // The body is its own item's span, so nothing that follows it can be dragged into what we sign.
  it('never signs bytes that trail the body', () => {
    const decision = decideSignRequest(requestUr({signData: Uint8Array.from([...BODY, 0xff])}), synced, TESTNET)
    if (decision.kind !== 'reviewable') throw new Error(`expected reviewable, got ${decision.kind}`)
    expect(decision.bodyHex).toBe(hex.encode(BODY))
  })
})

describe('requests it refuses', () => {
  // The attack: a body spending the real 10,405 tADA while the request declares 1 tADA.
  it('refuses a request that understates one of our own UTxOs', () => {
    const decision = decideSignRequest(requestUr({amount: '1000000'}), synced, TESTNET)
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(decision.reason).toBe('contradicts-our-state')
    expect(decision.detail).toMatch(/claims amount 1000000/)
  })

  it('refuses a tx-hash-only request', () => {
    const decision = decideSignRequest({type: UR_TYPE_SIGN_TX_HASH_REQUEST, cbor: new Uint8Array([1])}, synced, TESTNET)
    expect(decision).toMatchObject({kind: 'refused', reason: 'tx-hash-only'})
  })

  it('refuses a UR type we do not implement', () => {
    const decision = decideSignRequest({type: 'crypto-psbt', cbor: new Uint8Array([1])}, synced, TESTNET)
    expect(decision).toMatchObject({kind: 'refused', reason: 'unsupported-type', detail: 'crypto-psbt'})
  })

  it('refuses a payload that does not parse', () => {
    const decision = decideSignRequest(
      {type: UR_TYPE_SIGN_REQUEST, cbor: new Uint8Array([0xff, 0xff])},
      synced,
      TESTNET,
    )
    expect(decision).toMatchObject({kind: 'refused', reason: 'malformed'})
  })
})

/**
 * The gap this closes: a `cardano-sign-request` names no network anywhere, and a Cardano witness
 * is over the body hash — so a signature a testnet-configured wallet produces is perfectly valid
 * on mainnet. The claimed addresses are the only network the request states.
 */
describe('a request for another network', () => {
  const MAINNET_ADDR =
    'addr1q9d7zhmy0nfyt64mtyc0zynyzcnjqkxwzxs2ckyxdfhdvnsjw9nz0xstlq7cndkjkqcns6xg9lxnrxqu2dvexdyz2rvq2wt7jz'

  it('is refused before anything is rendered', () => {
    const decision = decideSignRequest(requestUr({address: MAINNET_ADDR}), synced, TESTNET)
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(decision.reason).toBe('wrong-network')
  })

  it('is refused on our network too, in the other direction', () => {
    const decision = decideSignRequest(requestUr(), synced, 1)
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(decision.reason).toBe('wrong-network')
  })

  it('is not refused when the networks agree', () => {
    expect(decideSignRequest(requestUr(), synced, TESTNET).kind).toBe('reviewable')
  })
})

describe('networkOfAddress', () => {
  it('reads the network off the bech32 prefix', () => {
    expect(
      networkOfAddress(
        'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
      ),
    ).toBe(0)
    expect(networkOfAddress('stake_test1uq8ac7qq')).toBe(0)
    expect(
      networkOfAddress(
        'addr1q9d7zhmy0nfyt64mtyc0zynyzcnjqkxwzxs2ckyxdfhdvnsjw9nz0xstlq7cndkjkqcns6xg9lxnrxqu2dvexdyz2rvq2wt7jz',
      ),
    ).toBe(1)
    expect(networkOfAddress('stake1uy9d7zhmy')).toBe(1)
  })

  // A Byron address carries no bech32 HRP. Having no opinion is right: it will not match our
  // synced set either, so it lands in `unknown` and behind the acknowledgement.
  it('has no opinion about an address it cannot classify', () => {
    expect(networkOfAddress('DdzFFzCqrhsf6hiTYkK5gBAhVDwg3SiaHiEL9wZLYU3WqLUpjucrmATkQ8JII')).toBeUndefined()
    expect(networkOfAddress('')).toBeUndefined()
  })
})

describe('networkMismatch', () => {
  it('only fires when the transaction declares one', () => {
    // `network_id` is an optional body field; absent is not a mismatch.
    expect(networkMismatch(undefined, 0)).toBe(false)
    expect(networkMismatch(0, 0)).toBe(false)
    expect(networkMismatch(1, 0)).toBe(true)
    expect(networkMismatch(0, 1)).toBe(true)
  })
})
