import {buildTrezorSignRequest} from '@evolution-sdk/hardware-cardano/Trezor'
import {blake2b} from '@noble/hashes/blake2.js'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {parseTransactionBody} from '../cardano/parse-tx-body'
import {bytesToHex, hexToBytes} from '../utils'

// -- Minimal CBOR builders for tx-body fixtures -------------------------------

const cborUint = (n: number): string => {
  if (n < 24) return n.toString(16).padStart(2, '0')
  if (n < 256) return `18${n.toString(16).padStart(2, '0')}`
  if (n < 65536) return `19${n.toString(16).padStart(4, '0')}`
  return `1a${n.toString(16).padStart(8, '0')}`
}

const cborNInt = (magnitude: number): string => {
  const v = magnitude - 1
  if (v < 24) return (0x20 + v).toString(16).padStart(2, '0')
  if (v < 256) return `38${v.toString(16).padStart(2, '0')}`
  return `39${v.toString(16).padStart(4, '0')}`
}

const cborBytes = (hex: string): string => {
  const len = hex.length / 2
  const prefix = len < 24 ? (0x40 + len).toString(16).padStart(2, '0') : `58${len.toString(16).padStart(2, '0')}`
  return `${prefix}${hex}`
}

const cborArray = (len: number): string => (0x80 + len).toString(16).padStart(2, '0')
const cborMap = (len: number): string => (0xa0 + len).toString(16).padStart(2, '0')
const cborTag = (tag: number): string =>
  tag < 24 ? (0xc0 + tag).toString(16) : `d9${tag.toString(16).padStart(4, '0')}`

const ZERO_HASH = '00'.repeat(32)
const ZERO_KEY_HASH = '00'.repeat(28)
const POOL_HASH = '77'.repeat(28)

const PAYMENT_PUB = '00'.repeat(32)
const STAKE_PUB = '11'.repeat(32)
const keyHashOf = (pubHex: string): string => bytesToHex(blake2b(hexToBytes(pubHex), {dkLen: 28}))
const PAYMENT_HASH = keyHashOf(PAYMENT_PUB)
const STAKE_HASH = keyHashOf(STAKE_PUB)

const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/0'/2/0"

const ENTERPRISE_ADDR_HEX = `60${ZERO_KEY_HASH}`
const OWN_BASE_ADDR_HEX = `01${PAYMENT_HASH}${STAKE_HASH}`
const OWN_REWARD_HEX = `e1${STAKE_HASH}`
const FOREIGN_REWARD_HEX = `e1${'22'.repeat(28)}`
const SCRIPT_REWARD_HEX = `f1${'44'.repeat(28)}`

const simpleInput = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(0)
const simpleOutput = (addrHex: string, amount = 1_000_000) => cborArray(2) + cborBytes(addrHex) + cborUint(amount)

const buildTxBody = (extra: string, extraKeys: number, outputs = cborArray(1) + simpleOutput(ENTERPRISE_ADDR_HEX)) =>
  cborMap(3 + extraKeys) +
  cborUint(0) +
  (cborArray(1) + simpleInput) +
  cborUint(1) +
  outputs +
  cborUint(2) +
  cborUint(200_000) +
  extra

const parse = (hex: string) => Effect.runPromise(parseTransactionBody(hex))

// CardanoTxSigningMode values from @trezor/protobuf.
const ORDINARY = 0
const MULTISIG = 2
const PLUTUS = 3

describe('buildTrezorSignRequest', () => {
  it('converts a simple payment tx in ordinary mode with witness requests', async () => {
    const {body, tagCborSets} = await parse(buildTxBody('', 0))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets})

    expect(request.signingMode).toBe(ORDINARY)
    expect(request.fee).toBe('200000')
    expect(request.inputs).toEqual([{prev_hash: ZERO_HASH, prev_index: 0}])
    expect(request.outputs[0]?.amount).toBe('1000000')
    // Bech32 rendering of the enterprise address (testnet header 0x60).
    expect(request.outputs[0]?.address?.startsWith('addr')).toBe(true)
    expect(request.outputs[0]?.format).toBeUndefined()
    expect(request.additionalWitnessRequests).toEqual([PAYMENT_PATH])
    expect(request.derivationType).toBe(2) // ICARUS_TREZOR
    expect(request.includeNetworkId).toBe(false)
    expect(request.tagCborSets).toBeUndefined()
  })

  it('marks own base-address change output with addressParameters', async () => {
    const outputs = cborArray(1) + simpleOutput(OWN_BASE_ADDR_HEX, 2_000_000)
    const {body} = await parse(buildTxBody('', 0, outputs))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {
      publicKeys: {[PAYMENT_PATH]: PAYMENT_PUB, [STAKE_PATH]: STAKE_PUB},
    })

    expect(request.outputs[0]?.address).toBeUndefined()
    expect(request.outputs[0]?.addressParameters).toEqual({
      addressType: 0, // BASE
      networkId: 1,
      protocolMagic: 764824073,
      spendingPath: PAYMENT_PATH,
      stakingPath: STAKE_PATH,
    })
  })

  it('keeps outputs as bech32 addresses without publicKeys', async () => {
    const outputs = cborArray(1) + simpleOutput(OWN_BASE_ADDR_HEX)
    const {body} = await parse(buildTxBody('', 0, outputs))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.outputs[0]?.address?.startsWith('addr1')).toBe(true)
    expect(request.outputs[0]?.addressParameters).toBeUndefined()
  })

  it('sets format=1 for Babbage map outputs and maps datum/inline datum', async () => {
    const inlineDatum = 'a10102'
    const datumOptionHash = cborArray(2) + cborUint(0) + cborBytes(ZERO_HASH)
    const datumOptionInline = cborArray(2) + cborUint(1) + cborTag(24) + cborBytes(inlineDatum)
    const mapOutput = (datumOption: string) =>
      cborMap(3) +
      cborUint(0) +
      cborBytes(ENTERPRISE_ADDR_HEX) +
      cborUint(1) +
      cborUint(2_000_000) +
      cborUint(2) +
      datumOption
    const outputs = cborArray(2) + mapOutput(datumOptionHash) + mapOutput(datumOptionInline)
    const {body} = await parse(buildTxBody('', 0, outputs))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.outputs[0]).toMatchObject({format: 1, datumHash: ZERO_HASH})
    expect(request.outputs[0]?.inlineDatum).toBeUndefined()
    expect(request.outputs[1]).toMatchObject({format: 1, inlineDatum})
    expect(request.outputs[1]?.datumHash).toBeUndefined()
  })

  it('sorts multi-asset token bundles canonically', async () => {
    const policyA = 'aa'.repeat(28)
    const policyB = 'bb'.repeat(28)
    const value =
      cborArray(2) +
      cborUint(2_000_000) +
      cborMap(2) +
      cborBytes(policyB) +
      (cborMap(1) + cborBytes('ff') + cborUint(5)) +
      cborBytes(policyA) +
      (cborMap(2) + cborBytes('aabb') + cborUint(7) + cborBytes('cc') + cborUint(9))
    const outputs = cborArray(1) + (cborArray(2) + cborBytes(ENTERPRISE_ADDR_HEX) + value)
    const {body} = await parse(buildTxBody('', 0, outputs))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    const bundle = request.outputs[0]?.tokenBundle
    expect(bundle?.map((g) => g.policyId)).toEqual([policyA, policyB])
    expect(bundle?.[0]?.tokenAmounts.map((t) => t.assetNameBytes)).toEqual(['cc', 'aabb'])
    expect(bundle?.[0]?.tokenAmounts[0]?.amount).toBe('9')
    expect(bundle?.[0]?.tokenAmounts[0]?.mintAmount).toBeUndefined()
  })

  it('converts a stake delegation certificate to the stake path', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const cert = cborArray(3) + cborUint(2) + cred + cborBytes(POOL_HASH)
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH])
    expect(request.signingMode).toBe(ORDINARY)
    expect(request.certificates).toEqual([{type: 2, path: STAKE_PATH, pool: POOL_HASH}])
  })

  it('converts Conway registration certs with deposits (kinds 7/8)', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const certs =
      cborArray(2) +
      (cborArray(3) + cborUint(7) + cred + cborUint(2_000_000)) +
      (cborArray(3) + cborUint(8) + cred + cborUint(2_000_000))
    const {body} = await parse(buildTxBody(cborUint(4) + certs, 1))

    const request = buildTrezorSignRequest(body, 1, [STAKE_PATH])
    expect(request.certificates).toEqual([
      {type: 7, path: STAKE_PATH, deposit: '2000000'},
      {type: 8, path: STAKE_PATH, deposit: '2000000'},
    ])
  })

  it('converts DRep vote delegation (key and no-confidence targets)', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const drepKey = cborArray(2) + cborUint(0) + cborBytes(ZERO_KEY_HASH)
    const drepNoConf = cborArray(1) + cborUint(3)
    const certs =
      cborArray(2) + (cborArray(3) + cborUint(9) + cred + drepKey) + (cborArray(3) + cborUint(9) + cred + drepNoConf)
    const {body} = await parse(buildTxBody(cborUint(4) + certs, 1))

    const request = buildTrezorSignRequest(body, 1, [STAKE_PATH])
    expect(request.certificates?.[0]).toMatchObject({type: 9, dRep: {type: 0, keyHash: ZERO_KEY_HASH}})
    expect(request.certificates?.[1]).toMatchObject({type: 9, dRep: {type: 3}})
  })

  it('escalates to plutus mode for foreign/script withdrawal credentials', async () => {
    const withdrawals =
      cborMap(3) +
      cborBytes(OWN_REWARD_HEX) +
      cborUint(100) +
      cborBytes(FOREIGN_REWARD_HEX) +
      cborUint(200) +
      cborBytes(SCRIPT_REWARD_HEX) +
      cborUint(300)
    const {body} = await parse(buildTxBody(cborUint(5) + withdrawals, 1))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH], {
      publicKeys: {[PAYMENT_PATH]: PAYMENT_PUB, [STAKE_PATH]: STAKE_PUB},
    })

    expect(request.signingMode).toBe(PLUTUS)
    expect(request.withdrawals).toContainEqual({amount: '100', path: STAKE_PATH})
    expect(request.withdrawals).toContainEqual({amount: '200', keyHash: '22'.repeat(28)})
    expect(request.withdrawals).toContainEqual({amount: '300', scriptHash: '44'.repeat(28)})
  })

  it('keeps ordinary mode and assumes own withdrawals when publicKeys is absent', async () => {
    const withdrawals = cborMap(1) + cborBytes(FOREIGN_REWARD_HEX) + cborUint(100)
    const {body} = await parse(buildTxBody(cborUint(5) + withdrawals, 1))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.signingMode).toBe(ORDINARY)
    expect(request.withdrawals).toEqual([{amount: '100', path: STAKE_PATH}])
  })

  it('converts a plutus tx: collateral, script data hash, required signers, reference inputs', async () => {
    const collateralInput = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(1)
    const collateralReturn = cborArray(2) + cborBytes(ENTERPRISE_ADDR_HEX) + cborUint(4_000_000)
    const refInput = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(2)
    const extra =
      cborUint(11) +
      cborBytes(ZERO_HASH) +
      cborUint(13) +
      (cborArray(1) + collateralInput) +
      cborUint(14) +
      (cborArray(1) + cborBytes(ZERO_KEY_HASH)) +
      cborUint(16) +
      collateralReturn +
      cborUint(17) +
      cborUint(5_000_000) +
      cborUint(18) +
      (cborArray(1) + refInput)
    const {body} = await parse(buildTxBody(extra, 6))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.signingMode).toBe(PLUTUS)
    expect(request.scriptDataHash).toBe(ZERO_HASH)
    expect(request.collateralInputs).toEqual([{prev_hash: ZERO_HASH, prev_index: 1}])
    expect(request.requiredSigners).toEqual([{keyHash: ZERO_KEY_HASH}])
    expect(request.collateralReturn?.amount).toBe('4000000')
    expect(request.totalCollateral).toBe('5000000')
    expect(request.referenceInputs).toEqual([{prev_hash: ZERO_HASH, prev_index: 2}])
  })

  it('converts mint with signed mintAmount values', async () => {
    const policy = 'aa'.repeat(28)
    const mint =
      cborMap(1) + cborBytes(policy) + (cborMap(2) + cborBytes('01') + cborUint(1000) + cborBytes('02') + cborNInt(500))
    const {body} = await parse(buildTxBody(cborUint(9) + mint, 1))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.mint).toEqual([
      {
        policyId: policy,
        tokenAmounts: [
          {assetNameBytes: '01', mintAmount: '1000'},
          {assetNameBytes: '02', mintAmount: '-500'},
        ],
      },
    ])
    expect(request.mint?.[0]?.tokenAmounts[0]?.amount).toBeUndefined()
  })

  it('propagates tagCborSets and maps ttl/validity/aux-data hash/network id', async () => {
    const extra =
      cborUint(3) +
      cborUint(500) +
      cborUint(7) +
      cborBytes(ZERO_HASH) +
      cborUint(8) +
      cborUint(400) +
      cborUint(15) +
      cborUint(1)
    const {body} = await parse(buildTxBody(extra, 4))

    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets: true})
    expect(request.ttl).toBe('500')
    expect(request.validityIntervalStart).toBe('400')
    expect(request.auxiliaryDataHash).toBe(ZERO_HASH)
    expect(request.includeNetworkId).toBe(true)
    expect(request.tagCborSets).toBe(true)
  })

  it('defaults protocolMagic by network and honours the override', async () => {
    const {body} = await parse(buildTxBody('', 0))
    expect(buildTrezorSignRequest(body, 1, [PAYMENT_PATH]).protocolMagic).toBe(764824073)
    expect(buildTrezorSignRequest(body, 0, [PAYMENT_PATH]).protocolMagic).toBe(1)
    expect(buildTrezorSignRequest(body, 0, [PAYMENT_PATH], {protocolMagic: 2}).protocolMagic).toBe(2)
  })

  it('builds CIP-36 registration auxiliary data', async () => {
    const {body} = await parse(buildTxBody('', 0))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH], {
      cip36Registration: {
        delegations: [
          {voteKeyHex: ZERO_HASH, weight: 1},
          {voteKeyHex: 'ff'.repeat(32), weight: 2},
        ],
        stakingPath: STAKE_PATH,
        paymentDestination: {
          type: 'device_owned',
          addressParams: {spendingPath: PAYMENT_PATH, stakingPath: STAKE_PATH},
        },
        nonce: '12345',
        votingPurpose: 0,
      },
    })

    expect(request.auxiliaryData?.cip36RegistrationParameters).toEqual({
      votingPublicKey: ZERO_HASH,
      stakingPath: STAKE_PATH,
      nonce: '12345',
      format: 0,
      paymentAddressParameters: {
        addressType: 0,
        networkId: 1,
        protocolMagic: 764824073,
        spendingPath: PAYMENT_PATH,
        stakingPath: STAKE_PATH,
      },
      delegations: [
        {votingPublicKey: ZERO_HASH, weight: 1},
        {votingPublicKey: 'ff'.repeat(32), weight: 2},
      ],
    })
  })

  it('throws for a DRep certificate, and points at the device that can do it', async () => {
    // A genuine Trezor gap: Ledger's app implements DRep registration/retirement/update, so
    // naming it is useful advice.
    const drepCred = cborArray(2) + cborUint(0) + cborBytes(ZERO_KEY_HASH)
    const cert = `${cborArray(4)}${cborUint(16)}${drepCred}${cborUint(500)}f6`
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))
    expect(() => buildTrezorSignRequest(body, 1, [STAKE_PATH])).toThrow(/not supported by Trezor.*Ledger/is)
  })

  it('throws for combined staking+governance certificates (kinds 10-13)', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const drep = cborArray(1) + cborUint(2)
    const cert = cborArray(4) + cborUint(10) + cred + cborBytes(POOL_HASH) + drep
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))
    // ⚠️ Not phrased as a Trezor limitation, and deliberately NOT pointing at a Ledger: CIP-21
    // forbids these on every hardware wallet and the Ledger converter refuses them too. The old
    // message advised a Ledger, and a 2026-10-08 Trezor report's author followed that advice.
    expect(() => buildTrezorSignRequest(body, 1, [STAKE_PATH])).toThrow(/CIP-21/i)
    expect(() => buildTrezorSignRequest(body, 1, [STAKE_PATH])).toThrow(/no device accepts one/i)
    expect(() => buildTrezorSignRequest(body, 1, [STAKE_PATH])).not.toThrow(/Ledger/i)
  })

  it('throws for transactions with voting procedures', async () => {
    const voter = cborArray(2) + cborUint(2) + cborBytes(ZERO_KEY_HASH)
    const govActionId = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(0)
    const procedure = `${cborArray(2)}${cborUint(1)}f6`
    const votes = cborMap(1) + voter + (cborMap(1) + govActionId + procedure)
    const {body} = await parse(buildTxBody(cborUint(19) + votes, 1))
    expect(() => buildTrezorSignRequest(body, 1, [PAYMENT_PATH])).toThrow(/voting procedures are not supported/i)
  })

  it('throws for treasury/donation fields', async () => {
    const {body} = await parse(buildTxBody(cborUint(21) + cborUint(777), 1))
    expect(() => buildTrezorSignRequest(body, 1, [PAYMENT_PATH])).toThrow(/treasury/i)
  })

  it('throws for unmodeled body keys', async () => {
    const {body} = await parse(buildTxBody(cborUint(6) + cborUint(0), 1))
    expect(() => buildTrezorSignRequest(body, 1, [PAYMENT_PATH])).toThrow(/unsupported field keys \(6\)/)
  })

  it('derives the stake path from a payment-only signing path set', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const cert = cborArray(3) + cborUint(2) + cred + cborBytes(POOL_HASH)
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))

    const request = buildTrezorSignRequest(body, 1, ["m/1852'/1815'/5'/1/7"])
    expect(request.certificates?.[0]?.path).toBe("m/1852'/1815'/5'/2/0")
  })
})

describe("buildTrezorSignRequest — a co-signer's share", () => {
  it("takes the caller's word that this is a multisig spend", async () => {
    // Nothing in a CIP-1854 spend distinguishes it: one signing path, and the
    // keys named by the script rather than by the body's `required_signers`. So
    // the mode is stated, and a device left to infer would sign in the wrong one.
    const {body, tagCborSets} = await parse(buildTxBody('', 0))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets, multisig: true})
    expect(request.signingMode).toBe(MULTISIG)
  })

  it('leaves every other transaction exactly as it was', async () => {
    const {body, tagCborSets} = await parse(buildTxBody('', 0))
    expect(buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets}).signingMode).toBe(ORDINARY)
    expect(buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets, multisig: false}).signingMode).toBe(ORDINARY)
  })

  it('is not downgraded to Plutus by a script credential it is expected to have', async () => {
    // The ordinary-mode escalation exists to find a mode that can represent a
    // script credential. Multisig already is that mode, so escalating past it
    // would swap a correct mode for one the device cannot witness this with.
    const {body, tagCborSets} = await parse(buildTxBody('', 0))
    const request = buildTrezorSignRequest(body, 1, [PAYMENT_PATH], {tagCborSets, multisig: true})
    expect(request.signingMode).not.toBe(PLUTUS)
  })
})
