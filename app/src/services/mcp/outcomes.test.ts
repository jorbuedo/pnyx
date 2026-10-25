import {beforeEach, describe, expect, it} from 'vitest'

import {type AgentOutcome, describeOutcome, forgetOutcomes, listOutcomes, OUTCOME_CAP, recordOutcome} from './outcomes'

const outcome = (over: Partial<AgentOutcome> = {}): AgentOutcome => ({
  txHash: 'aa',
  chain: 'cardano',
  stage: 'submitted',
  at: 1_000,
  ...over,
})

beforeEach(() => {
  forgetOutcomes()
})

describe('recordOutcome', () => {
  it('keeps the current stage for a hash rather than a history of it', () => {
    recordOutcome(outcome({txHash: 'aa', stage: 'awaiting-approval', at: 1}))
    recordOutcome(outcome({txHash: 'aa', stage: 'submitted', at: 2}))

    expect(listOutcomes('cardano')).toEqual([{txHash: 'aa', chain: 'cardano', stage: 'submitted', at: 2}])
  })

  it('returns the most recently updated first', () => {
    recordOutcome(outcome({txHash: 'aa', at: 1}))
    recordOutcome(outcome({txHash: 'bb', at: 2}))

    expect(listOutcomes('cardano').map((o) => o.txHash)).toEqual(['bb', 'aa'])
  })

  // An updated hash is the most recent thing that happened, so it must not be evicted as though it
  // were old — otherwise the transaction an agent is actively waiting on is the one that disappears.
  it('treats an update as recent for eviction', () => {
    recordOutcome(outcome({txHash: 'first', at: 1}))
    for (let i = 0; i < OUTCOME_CAP - 1; i++) recordOutcome(outcome({txHash: `filler-${i}`, at: 2}))
    recordOutcome(outcome({txHash: 'first', stage: 'submitted', at: 3}))
    recordOutcome(outcome({txHash: 'newest', at: 4}))

    const hashes = listOutcomes('cardano').map((o) => o.txHash)
    expect(hashes).toContain('first')
    expect(hashes).toContain('newest')
    expect(hashes).toHaveLength(OUTCOME_CAP)
  })

  it('keeps the chains apart', () => {
    recordOutcome(outcome({txHash: 'aa', chain: 'cardano'}))
    recordOutcome(outcome({txHash: 'bb', chain: 'midnight'}))

    expect(listOutcomes('cardano').map((o) => o.txHash)).toEqual(['aa'])
    expect(listOutcomes('midnight').map((o) => o.txHash)).toEqual(['bb'])
  })
})

describe('describeOutcome', () => {
  // ⚠️ The rule the whole module exists for: broadcast is not landed.
  it('never reports a submitted transaction as landed until the chain says so', () => {
    expect(describeOutcome(outcome({stage: 'submitted'}), 'pending').landed).toBeNull()
    expect(describeOutcome(outcome({stage: 'submitted'}), 'unknown').landed).toBeNull()
    expect(describeOutcome(outcome({stage: 'submitted'}), 'confirmed').landed).toBe(true)
    expect(describeOutcome(outcome({stage: 'submitted'}), 'failed').landed).toBe(false)
  })

  it('distinguishes "not yet" from "cannot tell"', () => {
    expect(describeOutcome(outcome(), 'pending').detail).toContain('has not decided yet')
    expect(describeOutcome(outcome(), 'unknown').detail).toContain('cannot currently tell')
  })

  // An agent told it was declined will not ask again, so a timeout must never read as a refusal.
  it('reports an unanswered review as not a refusal', () => {
    const described = describeOutcome(outcome({stage: 'unanswered'}), 'unknown')
    expect(described.detail).toContain('not a refusal')
    expect(described.landed).toBe(false)
  })

  it('reports a decline as the person’s decision', () => {
    expect(describeOutcome(outcome({stage: 'declined'}), 'unknown').detail).toContain('declined')
  })

  it('blames the wallet, not the person, when nothing was submitted', () => {
    const described = describeOutcome(outcome({stage: 'not-submitted'}), 'unknown')
    expect(described.detail).toContain('this wallet’s failure')
  })

  it('leaves an undecided review with no landed verdict at all', () => {
    expect(describeOutcome(outcome({stage: 'awaiting-approval'}), 'unknown').landed).toBeNull()
  })
})
