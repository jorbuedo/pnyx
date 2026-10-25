import {describe, expect, it} from 'vitest'
import {type TouchedScript, touchedScripts} from './script-hashes.js'
import type {ReviewedIO, ReviewedOperation, ReviewedTransaction} from './types.js'

const hash = (fill: string): string => fill.repeat(28)
const SCRIPT_A = hash('a1')
const SCRIPT_B = hash('b2')
const POLICY = hash('c3')
const KEY = hash('d4')

const io = (hashHex: string, type: 'key' | 'script'): ReviewedIO => ({
  address: {hex: (type === 'script' ? '71' : '61') + hashHex},
  ownership: {level: 'none'},
  amounts: [{quantity: 1_000_000n}],
  credentials: {payment: {hashHex, type}},
})

const tx = (over: Partial<ReviewedTransaction>): ReviewedTransaction =>
  ({
    chain: 'cardano',
    fee: 170_000n,
    inputs: [],
    unresolvedInputs: [],
    outputs: [],
    referenceInputs: [],
    metadata: {},
    requiredSigners: [],
    scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 0, redeemers: 0, datums: 0},
    ownDelta: [],
    ownGroup: {addresses: [], sent: [], received: []},
    identityGroup: {addresses: [], sent: [], received: []},
    escrowGroup: {addresses: [], sent: [], received: []},
    otherGroup: {addresses: [], sent: [], received: []},
    counterparties: [],
    operations: [],
    warnings: [],
    ...over,
  }) as ReviewedTransaction

const hashes = (t: readonly TouchedScript[]): readonly string[] => t.map((s) => s.hashHex)

describe('touchedScripts', () => {
  it('finds script payment credentials on inputs and outputs, and ignores key ones', () => {
    const result = touchedScripts(
      tx({inputs: [io(SCRIPT_A, 'script'), io(KEY, 'key')], outputs: [io(SCRIPT_B, 'script')]}),
    )
    expect(hashes(result)).toEqual([SCRIPT_A, SCRIPT_B])
    expect(result[0]?.sites).toEqual(['input'])
    expect(result[1]?.sites).toEqual(['output'])
  })

  it('treats a minting policy id as the script hash it is', () => {
    const minting: ReviewedOperation = {kind: 'minting', policyIdHex: POLICY, assets: [], burns: false}
    expect(hashes(touchedScripts(tx({operations: [minting]})))).toEqual([POLICY])
  })

  it('collects a script certificate credential, and skips a key one', () => {
    const scriptCert: ReviewedOperation = {
      kind: 'stake-delegation',
      credential: {hashHex: SCRIPT_A, type: 'script'},
      poolKeyHashHex: KEY,
    }
    const keyCert: ReviewedOperation = {
      kind: 'stake-delegation',
      credential: {hashHex: KEY, type: 'key'},
      poolKeyHashHex: KEY,
    }
    expect(hashes(touchedScripts(tx({operations: [scriptCert, keyCert]})))).toEqual([SCRIPT_A])
  })

  it('reads a withdrawal credential off the reward address header, script only', () => {
    const scriptWithdrawal: ReviewedOperation = {
      kind: 'reward-withdrawal',
      rewardAddress: {hex: `f0${SCRIPT_B}`},
      amount: 5n,
      own: false,
    }
    const keyWithdrawal: ReviewedOperation = {
      kind: 'reward-withdrawal',
      rewardAddress: {hex: `e0${KEY}`},
      amount: 5n,
      own: true,
    }
    expect(hashes(touchedScripts(tx({operations: [scriptWithdrawal, keyWithdrawal]})))).toEqual([SCRIPT_B])
  })

  it('de-duplicates one hash across sites, keeping every site it appeared at', () => {
    const minting: ReviewedOperation = {kind: 'minting', policyIdHex: SCRIPT_A, assets: [], burns: false}
    const result = touchedScripts(
      tx({inputs: [io(SCRIPT_A, 'script')], outputs: [io(SCRIPT_A, 'script')], operations: [minting]}),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.sites).toEqual(['input', 'output', 'mint'])
  })

  it('drops a malformed hash rather than asking the registry about it', () => {
    const short = {...io(SCRIPT_A, 'script'), credentials: {payment: {hashHex: 'abcd', type: 'script' as const}}}
    expect(touchedScripts(tx({inputs: [short]}))).toEqual([])
  })

  it('never reports the script-data hash — it is not a script', () => {
    const result = touchedScripts(
      tx({
        scriptDataHashHex: 'ff'.repeat(32),
        scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 1, redeemers: 1, datums: 0},
      }),
    )
    expect(result).toEqual([])
  })
})
