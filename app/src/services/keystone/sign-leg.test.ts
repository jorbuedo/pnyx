import type {UTxO} from '@evolution-sdk/evolution'
import {hex} from '@pnyx/crypto'
import {decodeCardanoSignature, encodeCardanoSignRequest, UR_TYPE_SIGN_REQUEST} from '@pnyx/ur'
import {describe, expect, it} from 'vitest'
import {testUtxo} from '../cardano/test-utxo'
import {confirmGate, describeWitnessOutcome, keystoneSigningRequest, signatureReply, witnessCoverage} from './sign-leg'
import {decideSignRequest, type SignRequestDecision} from './sign-request-review'

/** Cardano's own numbering: 0 testnet. Every fixture address here is `addr_test1…`. */
const TESTNET = 0

const HASH = new Uint8Array(32).fill(0x11)
const OTHER_HASH = new Uint8Array(32).fill(0x22)
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

const utxo = (transactionHash: Uint8Array, amount: string) => ({
  transactionHash,
  index: 0,
  amount,
  keyPath,
  address: ADDR,
})

/** A stand-in transaction body — `{0: 1, 2: 3}`. Opaque here; the signing request only carries it. */
const BODY = Uint8Array.from([0xa2, 0x00, 0x01, 0x02, 0x03])
/** What a counterparty puts in `signData`: the whole transaction `[body, {}, true, null]`. */
const FULL_TX = Uint8Array.from([0x84, ...BODY, 0xa0, 0xf5, 0xf6])

const requestUr = (utxos: ReturnType<typeof utxo>[], requestId?: Uint8Array) => ({
  type: UR_TYPE_SIGN_REQUEST,
  cbor: encodeCardanoSignRequest({
    signData: FULL_TX,
    utxos,
    extraSigners: [],
    ...(requestId === undefined ? {} : {requestId}),
  }),
})

const synced: UTxO.UTxO[] = [testUtxo({txHash: 0x11, address: ADDR, lovelace: 10_405_672_323n})]

const reviewable = (utxos: ReturnType<typeof utxo>[], requestId?: Uint8Array) => {
  const decision = decideSignRequest(requestUr(utxos, requestId), synced, TESTNET)
  if (decision.kind !== 'reviewable') throw new Error(`expected reviewable, got ${decision.kind}`)
  return decision
}

const context = {groupId: 'group-1', networkId: 0, protocolMagic: 1, accountIndex: 3}

describe('keystoneSigningRequest', () => {
  // The witness is over blake2b256(body). Signing the whole transaction the request carried would
  // hash `[body, witnesses, is_valid, aux]` instead — a valid signature over the wrong message.
  it('signs the transaction body, not the whole transaction the request carried', () => {
    const {bodyHex} = reviewable([utxo(HASH, '10405672323')])
    const signing = keystoneSigningRequest(bodyHex, context)
    expect(signing.payload).toMatchObject({_tag: 'CardanoTx', bodyHex: hex.encode(BODY)})
    // ⚠️ Not 0. The screen's selected account has to reach the request, because the signing paths are
    // resolved against it — a coalesced 0 signed with another account's keys.
    expect(signing.accountIndex).toBe(3)
  })

  it('asks for a witness set, never a broadcast', () => {
    const {bodyHex} = reviewable([utxo(HASH, '10405672323')])
    const signing = keystoneSigningRequest(bodyHex, context)
    expect(signing.payload).toMatchObject({signOnly: true, partial: true})
  })

  // The request states which key it thinks signs each input. Honouring that would let a
  // counterparty pick our signing key; the service resolves paths from the body instead.
  it('never carries the request-supplied key paths into the signing request', () => {
    const {bodyHex} = reviewable([utxo(HASH, '10405672323')])
    const signing = keystoneSigningRequest(bodyHex, context)
    if (signing.payload._tag !== 'CardanoTx') throw new Error('expected a CardanoTx payload')
    expect(signing.payload.precomputedSigningPaths).toBeUndefined()
    expect(signing.payload.precomputedRequiredKeyHashes).toBeUndefined()
  })

  it('carries the caller network, not one read off the request', () => {
    const {bodyHex} = reviewable([utxo(HASH, '10405672323')])
    const signing = keystoneSigningRequest(bodyHex, {
      groupId: 'g',
      networkId: 1,
      protocolMagic: 764824073,
      accountIndex: 2,
    })
    expect(signing.payload).toMatchObject({networkId: 1, protocolMagic: 764824073})
    expect(signing.groupId).toBe('g')
  })
})

describe('confirmGate', () => {
  it('offers confirmation directly when every input is verified', () => {
    expect(confirmGate(reviewable([utxo(HASH, '10405672323')]), false)).toEqual({
      canConfirm: true,
      needsAcknowledgement: false,
      unverifiedCount: 0,
    })
  })

  it('withholds confirmation until an unverified input is acknowledged', () => {
    const decision = reviewable([utxo(HASH, '10405672323'), utxo(OTHER_HASH, '250000000')])
    expect(confirmGate(decision, false)).toEqual({
      canConfirm: false,
      needsAcknowledgement: true,
      unverifiedCount: 1,
    })
    expect(confirmGate(decision, true)).toMatchObject({canConfirm: true, needsAcknowledgement: true})
  })

  it('counts every unverified input, since the copy names the number', () => {
    const decision = reviewable([utxo(OTHER_HASH, '1'), utxo(new Uint8Array(32).fill(0x33), '2')])
    expect(confirmGate(decision, true).unverifiedCount).toBe(2)
  })

  // A refusal is a statement that we know the request is wrong. No checkbox reopens it.
  it('never lets an acknowledgement unlock a refusal', () => {
    const refused: SignRequestDecision = {kind: 'refused', reason: 'contradicts-our-state', detail: 'x'}
    expect(confirmGate(refused, true)).toEqual({canConfirm: false, needsAcknowledgement: false, unverifiedCount: 0})
  })
})

describe('signatureReply', () => {
  const WITNESS_HEX = `a10081825820${'aa'.repeat(32)}5840${'bb'.repeat(64)}`

  it('round-trips the witness set through the registry item', () => {
    const decoded = decodeCardanoSignature(signatureReply(WITNESS_HEX, undefined))
    if (!decoded.ok) throw new Error(decoded.error)
    expect(hex.encode(decoded.value.witnessSet)).toBe(WITNESS_HEX)
  })

  it('echoes the request id so a coordinator can match the reply', () => {
    const requestId = new Uint8Array(16).fill(0xab)
    const decoded = decodeCardanoSignature(signatureReply(WITNESS_HEX, requestId))
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.requestId).toEqual(requestId)
  })

  it('omits the request id when the request carried none', () => {
    const decoded = decodeCardanoSignature(signatureReply(WITNESS_HEX, undefined))
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.requestId).toBeUndefined()
  })

  it('fails loudly rather than replying with garbage bytes', () => {
    expect(() => signatureReply('not-hex', undefined)).toThrow()
  })
})

describe('witnessCoverage', () => {
  const PAYMENT = 'aa'.repeat(28)
  const STAKE = 'bb'.repeat(28)
  const FOREIGN = 'cc'.repeat(28)

  it('reports full coverage when the signer will sign everything required', () => {
    expect(witnessCoverage([PAYMENT, STAKE], [PAYMENT, STAKE])).toEqual({required: 2, ours: 2, missing: []})
  })

  // The real shape of the Eternl dead end. The input sat at a multi-delegation address the wallet
  // filters out, so the signer could not resolve it and never required its payment credential —
  // even though the registry holds that key. Only the withdrawal's stake witness came back.
  it('counts a key the wallet owns but the signer will not use as missing', () => {
    expect(witnessCoverage([PAYMENT, STAKE], [STAKE])).toEqual({
      required: 2,
      ours: 1,
      missing: [PAYMENT],
    })
  })

  it('counts a required key nobody holds as missing too', () => {
    expect(witnessCoverage([PAYMENT, FOREIGN], [PAYMENT])).toEqual({required: 2, ours: 1, missing: [FOREIGN]})
  })

  it('counts a hash required twice once, so the totals match the witnesses produced', () => {
    expect(witnessCoverage([PAYMENT, PAYMENT], [PAYMENT])).toEqual({required: 1, ours: 1, missing: []})
  })

  it('matches regardless of hex case, which the two sides do not agree on', () => {
    expect(witnessCoverage([PAYMENT.toUpperCase()], [PAYMENT])).toEqual({required: 1, ours: 1, missing: []})
  })

  it('treats a body requiring nothing of us as covered rather than as a warning', () => {
    expect(witnessCoverage([], [PAYMENT])).toEqual({required: 0, ours: 0, missing: []})
  })
})

describe('describeWitnessOutcome', () => {
  it('calls out a signature-free result instead of presenting an empty reply', () => {
    expect(describeWitnessOutcome(0)).toEqual({kind: 'nothing-to-sign'})
  })

  it('reports how many witnesses were produced', () => {
    expect(describeWitnessOutcome(2)).toEqual({kind: 'signed', vkeyCount: 2})
  })
})
