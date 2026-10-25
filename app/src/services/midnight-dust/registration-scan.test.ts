import {describe, expect, it} from 'vitest'
import {encodeDustRegistrationDatum} from './registration-datum'
import {
  activeRegistrations,
  carriesDustAuthToken,
  DUST_MAPPING_POLICY_ID,
  isDustAuthToken,
  isDustRegistrationTx,
  type ScanTx,
} from './registration-scan'

const STAKE = '3a57af7913f0578ceddb35cd72e9abc3644189afb6607ce6d22d076e'
const OTHER_STAKE = 'aa'.repeat(28)
const DUST = '736eac3e7bd29f5f6f950d57d3218f1f3194ba91e2e5f9e27b5add9f75fc78613d'
const OTHER_DUST = 'bb'.repeat(33)

const authToken = {policyIdHex: DUST_MAPPING_POLICY_ID, assetNameHex: ''}

const regTx = (hash: string, slot: number, opts: {stake?: string; dust?: string; index?: number} = {}): ScanTx => ({
  hash,
  slot,
  inputs: [],
  outputs: [
    {tokens: []},
    {
      tokens: [authToken],
      ...(opts.index !== undefined ? {outpoint: {txHash: hash, index: opts.index}} : {}),
      inlineDatum: encodeDustRegistrationDatum(opts.stake ?? STAKE, opts.dust ?? DUST),
    },
  ],
})

/** A tx spending the auth-token output of `regHash` at `index` — a deregister or a modify. */
const spendTx = (hash: string, slot: number, regHash: string, index: number): ScanTx => ({
  hash,
  slot,
  inputs: [{tokens: [authToken], outpoint: {txHash: regHash, index}}],
  outputs: [{tokens: []}],
})

describe('isDustAuthToken', () => {
  it('matches the mapping policy with an empty asset name', () => {
    expect(isDustAuthToken(authToken)).toBe(true)
    expect(isDustAuthToken({policyIdHex: DUST_MAPPING_POLICY_ID.toUpperCase(), assetNameHex: ''})).toBe(true)
  })

  it('does not match another token under the same policy', () => {
    // The policy is a multi-purpose script; only the empty-named token authenticates a
    // registration, so matching on the policy alone would count unrelated assets.
    expect(isDustAuthToken({policyIdHex: DUST_MAPPING_POLICY_ID, assetNameHex: '01'})).toBe(false)
  })

  it('does not match a different policy', () => {
    expect(isDustAuthToken({policyIdHex: 'cc'.repeat(28), assetNameHex: ''})).toBe(false)
  })
})

describe('isDustRegistrationTx', () => {
  it('is true for a tx that creates a registration', () => {
    expect(isDustRegistrationTx(regTx('aa11', 100))).toBe(true)
  })

  it('is true for a tx that spends one — a modify or a deregister', () => {
    expect(isDustRegistrationTx(spendTx('bb22', 200, 'aa11', 1))).toBe(true)
  })

  it('is false for an ordinary transaction', () => {
    expect(isDustRegistrationTx({hash: 'cc33', slot: 1, inputs: [{tokens: []}], outputs: [{tokens: []}]})).toBe(false)
  })

  it('carriesDustAuthToken tolerates missing token lists', () => {
    expect(carriesDustAuthToken([{}, {tokens: []}])).toBe(false)
  })
})

describe('activeRegistrations', () => {
  it('finds a registration and reads its destination from the inline datum', () => {
    const regs = activeRegistrations([regTx('aa11', 100)], STAKE)

    expect(regs).toHaveLength(1)
    expect(regs[0]?.dustAddr).toBe(DUST)
    expect(regs[0]?.txSlot).toBe(100)
    // No reported outpoint, so the index comes from the array position — a synced output
    // does not always carry its own index.
    expect(regs[0]?.ref).toEqual({txHash: 'aa11', index: 1})
  })

  it('prefers the reported outpoint index over the array position', () => {
    const regs = activeRegistrations([regTx('aa11', 100, {index: 7})], STAKE)
    expect(regs[0]?.ref.index).toBe(7)
  })

  it('drops a registration a later transaction spent', () => {
    // Deregistering removes the UTxO; there is no `active` flag to read.
    const regs = activeRegistrations([regTx('aa11', 100), spendTx('bb22', 200, 'aa11', 1)], STAKE)
    expect(regs).toEqual([])
  })

  it('follows a modify: old registration spent, new one live', () => {
    const modified: ScanTx = {
      hash: 'bb22',
      slot: 200,
      inputs: [{tokens: [authToken], outpoint: {txHash: 'aa11', index: 1}}],
      outputs: [
        {tokens: [], ...{}},
        {tokens: [authToken], inlineDatum: encodeDustRegistrationDatum(STAKE, OTHER_DUST)},
      ],
    }
    const regs = activeRegistrations([regTx('aa11', 100), modified], STAKE)

    expect(regs).toHaveLength(1)
    expect(regs[0]?.dustAddr).toBe(OTHER_DUST)
    expect(regs[0]?.ref.txHash).toBe('bb22')
  })

  it('reports every live registration, newest first — this is how a double registration is caught', () => {
    // The chain permits this and observability then treats the account as UNREGISTERED, so
    // seeing both is the entire point of scanning our own history.
    const regs = activeRegistrations([regTx('aa11', 100), regTx('bb22', 300)], STAKE)

    expect(regs.map((r) => r.ref.txHash)).toEqual(['bb22', 'aa11'])
  })

  it('ignores a registration for a different stake key', () => {
    // The token can travel through a transaction our account took part in without the
    // registration being ours.
    expect(activeRegistrations([regTx('aa11', 100, {stake: OTHER_STAKE})], STAKE)).toEqual([])
  })

  it('leaves the destination undefined when no datum and no local record answer it', () => {
    const noDatum: ScanTx = {hash: 'aa11', slot: 100, inputs: [], outputs: [{tokens: [authToken]}]}

    expect(activeRegistrations([noDatum], STAKE)[0]?.dustAddr).toBeUndefined()
  })

  it('falls back to a locally recorded destination when the datum is absent', () => {
    const noDatum: ScanTx = {hash: 'aa11', slot: 100, inputs: [], outputs: [{tokens: [authToken]}]}

    const regs = activeRegistrations([noDatum], STAKE, (hash) => (hash === 'aa11' ? DUST : undefined))
    expect(regs[0]?.dustAddr).toBe(DUST)
  })

  it('ignores an auth-token input with no outpoint rather than dropping every registration', () => {
    // An input we cannot identify must not be treated as spending *something*.
    const vagueSpend: ScanTx = {hash: 'bb22', slot: 200, inputs: [{tokens: [authToken]}], outputs: [{tokens: []}]}

    expect(activeRegistrations([regTx('aa11', 100), vagueSpend], STAKE)).toHaveLength(1)
  })
})
