import type {ReviewedGovAction, ReviewedOperation} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {
  drepLabel,
  govActionId,
  govActionLabelKey,
  operationLabelKey,
  poolBech32,
  truncateMiddle,
  voterId,
} from './format'

const HASH28 = 'ab'.repeat(28)
const HASH32 = 'cd'.repeat(32)

describe('poolBech32', () => {
  it('encodes a 28-byte pool key hash to a pool1… id', () => {
    const id = poolBech32(HASH28)
    expect(id.startsWith('pool1')).toBe(true)
    expect(id).not.toBe(HASH28)
  })
  it('handles odd input without throwing', () => {
    expect(typeof poolBech32('zz')).toBe('string')
  })
})

describe('drepLabel', () => {
  it('encodes a key-hash DRep to a drep1… id (CIP-129)', () => {
    const l = drepLabel({type: 'key_hash', keyHashHex: HASH28})
    expect(l.kind).toBe('id')
    expect(l.id?.startsWith('drep1')).toBe(true)
  })
  it('reports abstain / no-confidence as their own kinds', () => {
    expect(drepLabel({type: 'abstain'}).kind).toBe('abstain')
    expect(drepLabel({type: 'no_confidence'}).kind).toBe('noConfidence')
  })
})

describe('voterId', () => {
  it('encodes drep / committee-hot / pool voters', () => {
    expect(voterId({role: 'drep', credential: {hashHex: HASH28, type: 'key'}}).startsWith('drep1')).toBe(true)
    expect(voterId({role: 'committee_hot', credential: {hashHex: HASH28, type: 'key'}}).startsWith('cc_hot1')).toBe(
      true,
    )
    expect(voterId({role: 'pool', keyHashHex: HASH28}).startsWith('pool1')).toBe(true)
  })
})

describe('govActionId', () => {
  it('encodes a gov_action1… id from tx hash + index', () => {
    expect(govActionId(HASH32, 0).startsWith('gov_action1')).toBe(true)
    expect(govActionId(HASH32, 3)).not.toBe(govActionId(HASH32, 0))
  })
})

describe('truncateMiddle', () => {
  it('keeps short strings and middle-truncates long ones', () => {
    expect(truncateMiddle('short')).toBe('short')
    const long = 'a'.repeat(40)
    const out = truncateMiddle(long, 10, 6)
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(long.length)
  })
})

describe('operationLabelKey', () => {
  it('maps every operation kind to a leaf key', () => {
    const kinds: ReviewedOperation['kind'][] = [
      'stake-registration',
      'stake-delegation',
      'vote-delegation',
      'reward-withdrawal',
      'voting-procedures',
      'proposal-procedures',
      'contract-execution',
      'unknown-certificate',
    ]
    for (const kind of kinds) {
      const op = {kind, burns: false} as unknown as ReviewedOperation
      expect(typeof operationLabelKey(op)).toBe('string')
    }
  })
  it('distinguishes mint vs burn', () => {
    const mint = {kind: 'minting', policyIdHex: 'aa', assets: [], burns: false} as ReviewedOperation
    const burn = {kind: 'minting', policyIdHex: 'aa', assets: [], burns: true} as ReviewedOperation
    expect(operationLabelKey(mint)).toBe('minting')
    expect(operationLabelKey(burn)).toBe('burning')
  })
})

describe('govActionLabelKey', () => {
  it('maps each gov-action type', () => {
    const actions: ReviewedGovAction['type'][] = [
      'parameter_change',
      'hard_fork',
      'treasury_withdrawals',
      'no_confidence',
      'update_committee',
      'new_constitution',
      'info',
    ]
    for (const type of actions) {
      expect(typeof govActionLabelKey({type} as ReviewedGovAction)).toBe('string')
    }
  })
})
