import {buildLedgerSignRequest} from '@evolution-sdk/hardware-cardano/Ledger'
import {blake2b} from '@noble/hashes/blake2.js'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {parseTransactionBody} from '../cardano/parse-tx-body'
import {bytesToHex, hexToBytes} from '../utils'
import type {LedgerCredentialParams} from './types'

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

const cborText = (str: string): string => {
  const hex = bytesToHex(new TextEncoder().encode(str))
  const len = hex.length / 2
  const prefix = len < 24 ? (0x60 + len).toString(16).padStart(2, '0') : `78${len.toString(16).padStart(2, '0')}`
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
const DREP_PUB = '33'.repeat(32)
const keyHashOf = (pubHex: string): string => bytesToHex(blake2b(hexToBytes(pubHex), {dkLen: 28}))
const PAYMENT_HASH = keyHashOf(PAYMENT_PUB)
const STAKE_HASH = keyHashOf(STAKE_PUB)
const DREP_HASH = keyHashOf(DREP_PUB)

const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/0'/2/0"
const DREP_PATH = "m/1852'/1815'/0'/3/0"
const H = 0x80000000
const PAYMENT_PATH_NUM = [H + 1852, H + 1815, H, 0, 0]
const STAKE_PATH_NUM = [H + 1852, H + 1815, H, 2, 0]

// Enterprise testnet address (header 0x60) with a zero payment key hash.
const ENTERPRISE_ADDR_HEX = `60${ZERO_KEY_HASH}`
// Mainnet base address (header 0x01) owned by PAYMENT/STAKE keys above.
const OWN_BASE_ADDR_HEX = `01${PAYMENT_HASH}${STAKE_HASH}`
// Mainnet key-based / script-based reward accounts.
const OWN_REWARD_HEX = `e1${STAKE_HASH}`
const FOREIGN_REWARD_HEX = `e1${'22'.repeat(28)}`
const SCRIPT_REWARD_HEX = `f1${'44'.repeat(28)}`

const simpleInput = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(0)
const simpleOutput = (addrHex: string, amount = 1_000_000) => cborArray(2) + cborBytes(addrHex) + cborUint(amount)

/** Body map with inputs (0), outputs (1), fee (2) plus `extra` entries. */
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

describe('buildLedgerSignRequest', () => {
  it('converts a simple payment tx in ordinary mode with input payment paths', async () => {
    const {body, tagCborSets} = await parse(buildTxBody('', 0))
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'ordinary_transaction', {tagCborSets})

    expect(request.signingMode).toBe('ordinary_transaction')
    expect(request.tx.fee).toBe('200000')
    expect(request.tx.inputs).toEqual([{txHashHex: ZERO_HASH, outputIndex: 0, path: PAYMENT_PATH_NUM}])
    expect(request.tx.outputs[0]).toMatchObject({
      format: 0,
      amount: '1000000',
      destination: {type: 'third_party', params: {addressHex: ENTERPRISE_ADDR_HEX}},
    })
    // Input path is embedded → not repeated in additionalWitnessPaths.
    expect(request.tx.includeNetworkId).toBe(false)
    expect(request.additionalWitnessPaths).toEqual([])
    expect(request.options).toBeUndefined()
  })

  it('marks own base-address change output as device_owned', async () => {
    const outputs = cborArray(1) + simpleOutput(OWN_BASE_ADDR_HEX, 2_000_000)
    const {body} = await parse(buildTxBody('', 0, outputs))
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'ordinary_transaction', {
      tagCborSets: false,
      publicKeys: {[PAYMENT_PATH]: PAYMENT_PUB, [STAKE_PATH]: STAKE_PUB},
    })

    expect(request.tx.outputs[0]?.destination).toEqual({
      type: 'device_owned',
      params: {
        type: 0,
        params: {spendingPath: PAYMENT_PATH_NUM, stakingPath: STAKE_PATH_NUM},
      },
    })
  })

  it('keeps foreign outputs third_party and omits device_owned without publicKeys', async () => {
    const outputs = cborArray(1) + simpleOutput(OWN_BASE_ADDR_HEX)
    const {body} = await parse(buildTxBody('', 0, outputs))
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'ordinary_transaction', {tagCborSets: false})
    expect(request.tx.outputs[0]?.destination.type).toBe('third_party')
  })

  it('sorts multi-asset token bundles canonically (policy bytewise, names length-first)', async () => {
    const policyA = 'aa'.repeat(28)
    const policyB = 'bb'.repeat(28)
    // Names deliberately out of canonical order: longer name first, higher policy first.
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

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH])
    const bundle = request.tx.outputs[0]?.tokenBundle
    expect(bundle?.map((g) => g.policyIdHex)).toEqual([policyA, policyB])
    expect(bundle?.[0]?.tokens.map((t) => t.assetNameHex)).toEqual(['cc', 'aabb'])
  })

  it('converts a stake delegation certificate with own stake path fallback', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const cert = cborArray(3) + cborUint(2) + cred + cborBytes(POOL_HASH)
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH])
    expect(request.tx.certificates).toEqual([
      {
        type: 2,
        params: {
          stakeCredential: {type: 0, keyPath: STAKE_PATH_NUM},
          poolKeyHashHex: POOL_HASH,
        },
      },
    ])
    // Embedded stake path filtered out; payment path attached to inputs, also filtered.
    expect(request.additionalWitnessPaths).toEqual([])
  })

  it('converts DRep vote delegation (key and abstain targets)', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const drepKey = cborArray(2) + cborUint(0) + cborBytes(DREP_HASH)
    const drepAbstain = cborArray(1) + cborUint(2)
    const certs =
      cborArray(2) + (cborArray(3) + cborUint(9) + cred + drepKey) + (cborArray(3) + cborUint(9) + cred + drepAbstain)
    const {body} = await parse(buildTxBody(cborUint(4) + certs, 1))

    const request = buildLedgerSignRequest(body, 1, [STAKE_PATH])
    expect(request.tx.certificates?.[0]).toMatchObject({type: 9, params: {dRep: {type: 1, keyHashHex: DREP_HASH}}})
    expect(request.tx.certificates?.[1]).toMatchObject({type: 9, params: {dRep: {type: 3}}})
  })

  it('resolves withdrawals: own → KEY_PATH, foreign → KEY_HASH + plutus escalation, script → SCRIPT_HASH', async () => {
    const withdrawals =
      cborMap(3) +
      cborBytes(OWN_REWARD_HEX) +
      cborUint(100) +
      cborBytes(FOREIGN_REWARD_HEX) +
      cborUint(200) +
      cborBytes(SCRIPT_REWARD_HEX) +
      cborUint(300)
    const {body} = await parse(buildTxBody(cborUint(5) + withdrawals, 1))

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH], 'ordinary_transaction', {
      tagCborSets: false,
      publicKeys: {[PAYMENT_PATH]: PAYMENT_PUB, [STAKE_PATH]: STAKE_PUB},
    })

    // Foreign + script credentials force PLUTUS mode.
    expect(request.signingMode).toBe('plutus_transaction')
    const creds = request.tx.withdrawals?.map((w) => w.stakeCredential)
    expect(creds).toContainEqual({type: 0, keyPath: STAKE_PATH_NUM})
    expect(creds).toContainEqual({type: 1, keyHashHex: '22'.repeat(28)})
    expect(creds).toContainEqual({type: 2, scriptHashHex: '44'.repeat(28)})
  })

  it('assumes withdrawals are own (stake KEY_PATH) when publicKeys is absent', async () => {
    const withdrawals = cborMap(1) + cborBytes(OWN_REWARD_HEX) + cborUint(100)
    const {body} = await parse(buildTxBody(cborUint(5) + withdrawals, 1))
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.signingMode).toBe('ordinary_transaction')
    expect(request.tx.withdrawals?.[0]?.stakeCredential).toEqual({type: 0, keyPath: STAKE_PATH_NUM})
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
      (cborArray(2) + cborBytes(PAYMENT_HASH) + cborBytes(ZERO_KEY_HASH)) +
      cborUint(16) +
      collateralReturn +
      cborUint(17) +
      cborUint(5_000_000) +
      cborUint(18) +
      (cborArray(1) + refInput)
    const {body} = await parse(buildTxBody(extra, 6))

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'plutus_transaction', {
      tagCborSets: false,
      publicKeys: {[PAYMENT_PATH]: PAYMENT_PUB},
    })

    expect(request.signingMode).toBe('plutus_transaction')
    // Plutus mode: no path on inputs.
    expect(request.tx.inputs).toEqual([{txHashHex: ZERO_HASH, outputIndex: 0}])
    expect(request.tx.scriptDataHashHex).toBe(ZERO_HASH)
    expect(request.tx.collateralInputs).toEqual([{txHashHex: ZERO_HASH, outputIndex: 1}])
    expect(request.tx.requiredSigners).toEqual([
      {type: 'required_signer_path', path: PAYMENT_PATH_NUM},
      {type: 'required_signer_hash', hashHex: ZERO_KEY_HASH},
    ])
    expect(request.tx.collateralOutput?.amount).toBe('4000000')
    expect(request.tx.totalCollateral).toBe('5000000')
    expect(request.tx.referenceInputs).toEqual([{txHashHex: ZERO_HASH, outputIndex: 2}])
    // Own path embedded via requiredSigners → filtered from additionalWitnessPaths.
    expect(request.additionalWitnessPaths).toEqual([])
  })

  it('includes every signing path in additionalWitnessPaths in multisig mode', async () => {
    const {body} = await parse(buildTxBody('', 0))
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH, STAKE_PATH], 'multisig_transaction', {
      tagCborSets: false,
    })
    expect(request.additionalWitnessPaths).toEqual([PAYMENT_PATH_NUM, STAKE_PATH_NUM])
    expect(request.tx.inputs[0]?.path).toBeUndefined()
  })

  it('converts voting procedures with own DRep key upgraded to key path', async () => {
    const voter = cborArray(2) + cborUint(2) + cborBytes(DREP_HASH)
    const govActionId = cborArray(2) + cborBytes(ZERO_HASH) + cborUint(3)
    const procedure = `${cborArray(2)}${cborUint(1)}f6`
    const votes = cborMap(1) + voter + (cborMap(1) + govActionId + procedure)
    const {body} = await parse(buildTxBody(cborUint(19) + votes, 1))

    const foreign = buildLedgerSignRequest(body, 1, [PAYMENT_PATH])
    expect(foreign.tx.votingProcedures).toEqual([
      {
        voter: {type: 2, keyHashHex: DREP_HASH},
        votes: [{govActionId: {txHashHex: ZERO_HASH, govActionIndex: 3}, votingProcedure: {vote: 1}}],
      },
    ])

    const own = buildLedgerSignRequest(body, 1, [DREP_PATH], 'ordinary_transaction', {
      tagCborSets: false,
      publicKeys: {[DREP_PATH]: DREP_PUB},
    })
    expect(own.tx.votingProcedures?.[0]?.voter).toEqual({
      type: 102,
      keyPath: [H + 1852, H + 1815, H, 3, 0],
    })
  })

  it('maps ttl, validity start, aux-data hash, network id, treasury and donation', async () => {
    const extra =
      cborUint(3) +
      cborUint(500) +
      cborUint(7) +
      cborBytes(ZERO_HASH) +
      cborUint(8) +
      cborUint(400) +
      cborUint(15) +
      cborUint(1) +
      cborUint(21) +
      cborUint(777) +
      cborUint(22) +
      cborUint(888)
    const {body} = await parse(buildTxBody(extra, 6))

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.tx.ttl).toBe('500')
    expect(request.tx.validityIntervalStart).toBe('400')
    expect(request.tx.auxiliaryData).toEqual({type: 'arbitrary_hash', params: {hashHex: ZERO_HASH}})
    expect(request.tx.includeNetworkId).toBe(true)
    expect(request.tx.treasury).toBe('777')
    expect(request.tx.donation).toBe('888')
  })

  it('converts mint with signed amounts and canonical ordering', async () => {
    const policy = 'aa'.repeat(28)
    const mint =
      cborMap(1) + cborBytes(policy) + (cborMap(2) + cborBytes('01') + cborUint(1000) + cborBytes('02') + cborNInt(500))
    const {body} = await parse(buildTxBody(cborUint(9) + mint, 1))

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH])
    expect(request.tx.mint).toEqual([
      {
        policyIdHex: policy,
        tokens: [
          {assetNameHex: '01', amount: '1000'},
          {assetNameHex: '02', amount: '-500'},
        ],
      },
    ])
  })

  it('propagates tagCborSets from the parsed body', async () => {
    const taggedInputs = cborTag(258) + cborArray(1) + simpleInput
    const bodyHex =
      cborMap(3) +
      cborUint(0) +
      taggedInputs +
      cborUint(1) +
      (cborArray(1) + simpleOutput(ENTERPRISE_ADDR_HEX)) +
      cborUint(2) +
      cborUint(200_000)
    const {body, tagCborSets} = await parse(bodyHex)
    expect(tagCborSets).toBe(true)

    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'ordinary_transaction', {tagCborSets})
    expect(request.options).toEqual({tagCborSets: true})
  })

  it('defaults protocolMagic by network and honours the override', async () => {
    const {body} = await parse(buildTxBody('', 0))
    expect(buildLedgerSignRequest(body, 1, [PAYMENT_PATH]).tx.network.protocolMagic).toBe(764824073)
    expect(buildLedgerSignRequest(body, 0, [PAYMENT_PATH]).tx.network.protocolMagic).toBe(1)
    expect(
      buildLedgerSignRequest(body, 0, [PAYMENT_PATH], 'ordinary_transaction', {tagCborSets: false, protocolMagic: 2}).tx
        .network.protocolMagic,
    ).toBe(2)
  })

  it('passes a pre-built CIP-36 registration through as auxiliary data', async () => {
    const {body} = await parse(buildTxBody(cborUint(7) + cborBytes(ZERO_HASH), 1))
    const cip36 = {
      type: 'cip36_registration' as const,
      params: {
        format: 'cip_36' as const,
        delegations: [{type: 'cip36_vote_key_keyHex' as const, voteKeyHex: ZERO_HASH, weight: 1}],
        stakingPath: STAKE_PATH_NUM,
        paymentDestination: {type: 'third_party' as const, params: {addressHex: ENTERPRISE_ADDR_HEX}},
        nonce: '12345',
        votingPurpose: 0,
      },
    }
    const request = buildLedgerSignRequest(body, 1, [PAYMENT_PATH], 'ordinary_transaction', {
      tagCborSets: false,
      cip36Registration: cip36,
    })
    expect(request.tx.auxiliaryData).toEqual(cip36)
  })

  it('converts Conway registration certificates with deposits (kinds 7/8) and DRep certs (16/17/18)', async () => {
    const stakeCred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const drepCred = cborArray(2) + cborUint(0) + cborBytes(DREP_HASH)
    const anchor = cborArray(2) + cborText('https://example.com') + cborBytes(ZERO_HASH)
    const certs =
      cborArray(5) +
      (cborArray(3) + cborUint(7) + stakeCred + cborUint(2_000_000)) +
      (cborArray(3) + cborUint(8) + stakeCred + cborUint(2_000_000)) +
      (cborArray(4) + cborUint(16) + drepCred + cborUint(500_000_000) + anchor) +
      (cborArray(3) + cborUint(17) + drepCred + cborUint(500_000_000)) +
      `${cborArray(3) + cborUint(18) + drepCred}f6`
    const {body} = await parse(buildTxBody(cborUint(4) + certs, 1))

    const request = buildLedgerSignRequest(body, 1, [STAKE_PATH])
    const types = request.tx.certificates?.map((c) => c.type)
    expect(types).toEqual([7, 8, 16, 17, 18])
    const reg = request.tx.certificates?.[2]?.params as {deposit: string; anchor: {url: string} | null}
    expect(reg.deposit).toBe('500000000')
    expect(reg.anchor).toEqual({url: 'https://example.com', hashHex: ZERO_HASH})
    const update = request.tx.certificates?.[4]?.params as {anchor: LedgerCredentialParams | null}
    expect(update.anchor).toBeNull()
  })

  it('throws for combined staking+governance certificates (kinds 10-13)', async () => {
    const cred = cborArray(2) + cborUint(0) + cborBytes(STAKE_HASH)
    const drep = cborArray(1) + cborUint(2)
    const cert = cborArray(4) + cborUint(10) + cred + cborBytes(POOL_HASH) + drep
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))
    expect(() => buildLedgerSignRequest(body, 1, [STAKE_PATH])).toThrow(/combined staking\+governance/i)
  })

  it('throws for pool retirement certificates', async () => {
    const cert = cborArray(3) + cborUint(4) + cborBytes(POOL_HASH) + cborUint(300)
    const {body} = await parse(buildTxBody(cborUint(4) + cborArray(1) + cert, 1))
    expect(() => buildLedgerSignRequest(body, 1, [STAKE_PATH])).toThrow(/pool certificates/i)
  })

  it('throws for unmodeled body keys', async () => {
    const {body} = await parse(buildTxBody(cborUint(6) + cborUint(0), 1))
    expect(() => buildLedgerSignRequest(body, 1, [PAYMENT_PATH])).toThrow(/unsupported field keys \(6\)/)
  })
})
