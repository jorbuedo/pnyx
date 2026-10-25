import type {AddressGroup, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {metadataProtocol} from './protocol'

const emptyGroup: AddressGroup = {entries: [], deltas: [], parties: []}
/** A counterparty that received value — i.e. the transaction moved money outward. */
const receivingGroup: AddressGroup = {
  entries: [],
  deltas: [],
  parties: [{ownership: {level: 'none'}, addresses: [{hex: 'ff'}], sent: [], received: [{quantity: 1n}]}],
}

const tx = (
  metadata: Record<string, unknown>,
  groups: Partial<Pick<ReviewedTransaction, 'identityGroup' | 'escrowGroup' | 'otherGroup'>> = {},
): ReviewedTransaction =>
  ({
    hash: 'x',
    metadata,
    operations: [],
    ownDelta: [],
    inputs: [],
    outputs: [],
    ownGroup: emptyGroup,
    identityGroup: emptyGroup,
    escrowGroup: emptyGroup,
    otherGroup: emptyGroup,
    ...groups,
  }) as unknown as ReviewedTransaction

describe('metadataProtocol', () => {
  it('names the protocol a registered label belongs to', () => {
    expect(metadataProtocol(tx({'1447': {org: {}}}))).toMatchObject({
      label: '1447',
      name: 'Reeve: financial records',
    })
  })

  it('returns null for an unregistered label rather than inventing a protocol', () => {
    // ~98.5% of labels in use are unregistered; naming one would be a guess.
    expect(metadataProtocol(tx({'999999': {a: 1}}))).toBeNull()
  })

  it('returns null when there is no metadata at all', () => {
    expect(metadataProtocol(tx({}))).toBeNull()
  })

  it('ignores CIP-20, which is the sender’s message rather than a protocol', () => {
    expect(metadataProtocol(tx({'674': {msg: ['thanks']}}))).toBeNull()
  })

  it('picks the lowest label so several protocols name the tx deterministically', () => {
    // Object key order is not a contract; ascending numeric order is.
    const both = metadataProtocol(tx({'1447': {}, '721': {}}))
    expect(both?.label).toBe('721')
  })

  describe('whether the protocol may title the transaction', () => {
    // The rule `isPureRewardWithdrawal` already uses: a payload that rode along with a
    // transfer must not bury the fact that money moved.
    it('is carrier-only when nothing reached anyone else', () => {
      expect(metadataProtocol(tx({'1447': {}}))?.isCarrierOnly).toBe(true)
    })

    it('is not carrier-only when a counterparty received value', () => {
      expect(metadataProtocol(tx({'1447': {}}, {otherGroup: receivingGroup}))?.isCarrierOnly).toBe(false)
    })

    it('counts our own identity as somebody the money went to', () => {
      expect(metadataProtocol(tx({'1447': {}}, {identityGroup: receivingGroup}))?.isCarrierOnly).toBe(false)
    })

    it('counts an escrow too', () => {
      expect(metadataProtocol(tx({'1447': {}}, {escrowGroup: receivingGroup}))?.isCarrierOnly).toBe(false)
    })
  })
})
