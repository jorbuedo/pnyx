import {describe, expect, it} from 'vitest'

import {isSameTransaction, type MidnightActivity, outcomeOf} from './midnight-activity'

const row = (identifiers: readonly string[]): MidnightActivity => ({
  transactionId: 1,
  hash: 'landed-hash',
  direction: 'sent',
  netByToken: new Map(),
  tokens: new Set(),
  ourSpentCount: 1,
  ourCreatedCount: 1,
  counterparties: [],
  identifiers,
})

describe('isSameTransaction', () => {
  it('matches when one of the send’s identifiers is among the landed transaction’s', () => {
    // The sponsor merges its balancing in, so the landed set is a superset. This is the real shape.
    expect(isSameTransaction(row(['aa', 'bb-from-the-sponsor']), ['aa'])).toBe(true)
  })

  it('does not require the sets to be equal', () => {
    expect(isSameTransaction(row(['aa', 'bb', 'cc']), ['bb'])).toBe(true)
  })

  it('is case-insensitive, since hex casing is not a fact about the transaction', () => {
    expect(isSameTransaction(row(['AA11']), ['aa11'])).toBe(true)
  })

  it('does not match an unrelated transaction', () => {
    expect(isSameTransaction(row(['aa']), ['zz'])).toBe(false)
  })

  it('never matches on an empty pending set — that would attach a send to the next row to arrive', () => {
    expect(isSameTransaction(row(['aa']), [])).toBe(false)
  })

  it('does not match a row the indexer gave no identifiers for', () => {
    expect(isSameTransaction(row([]), ['aa'])).toBe(false)
  })
})

describe('outcomeOf', () => {
  it('reads a full success, whose segment list is empty by design', () => {
    // The indexer sends no per-segment detail when nothing failed, so [] must not read as "none ran".
    expect(outcomeOf({status: 'SUCCESS', segments: []})).toEqual({status: 'SUCCESS', segments: []})
  })

  it('reads per-segment truth on a partial success', () => {
    expect(
      outcomeOf({
        status: 'PARTIAL_SUCCESS',
        segments: [
          {id: 0, success: true},
          {id: 1, success: false},
        ],
      }),
    ).toEqual({
      status: 'PARTIAL_SUCCESS',
      segments: [
        {id: 0, success: true},
        {id: 1, success: false},
      ],
    })
  })

  it('reads a failure', () => {
    expect(outcomeOf({status: 'FAILURE', segments: null})?.status).toBe('FAILURE')
  })

  it('returns undefined when the indexer reported no result', () => {
    expect(outcomeOf(undefined)).toBeUndefined()
    expect(outcomeOf(null)).toBeUndefined()
    expect(outcomeOf({})).toBeUndefined()
  })

  it('drops a status this build does not know rather than coercing it', () => {
    // Reading an unknown status as one of the three would state an outcome the chain never gave.
    expect(outcomeOf({status: 'SOMETHING_NEW'})).toBeUndefined()
  })

  it('drops a partial segment rather than inventing an id or a verdict', () => {
    expect(
      outcomeOf({status: 'PARTIAL_SUCCESS', segments: [{id: 1}, {success: true}, {id: 2, success: false}]}),
    ).toEqual({status: 'PARTIAL_SUCCESS', segments: [{id: 2, success: false}]})
  })
})
