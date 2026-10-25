/**
 * The pure half of the DUST indexer client: reading a spend's replay inputs off its transaction.
 *
 * The subscription itself needs a socket, but this does not — and it is the part with the judgement
 * calls, because every shape below has been served by a real indexer or is one field away from being.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'

import {readSpendReplayFromTransaction} from './dust-indexer'

const spendEvent = {__typename: 'DustSpendProcessed', raw: 'abcd'}

describe('reading a spend’s replay inputs off its transaction', () => {
  it('reads the commitment range and the event of a single-commitment spend', () => {
    const read = readSpendReplayFromTransaction(
      {dustCommitmentStartIndex: 41, dustCommitmentEndIndex: 42, dustLedgerEvents: [spendEvent]},
      'aa',
    )
    expect(read.commitmentStart).toBe(41)
    expect(read.commitmentEnd).toBe(42)
    expect(read.spendEvents).toEqual(['abcd'])
  })

  it('reads a wide range instead of refusing it', () => {
    // ⚠️ **The regression this function exists for.** It used to return the successor's index and only
    // when the range held exactly one commitment — a condition change splitting makes unsatisfiable, so
    // every self-funded send that split its change had its DUST orphaned. Measured on preprod
    // 2026-09-01: ranges of 2, 3, 3, 10 and 10, all dropped as unrepairable.
    const read = readSpendReplayFromTransaction(
      {
        dustCommitmentStartIndex: 1076382,
        dustCommitmentEndIndex: 1076392,
        dustLedgerEvents: [spendEvent, {__typename: 'DustGenerationDtimeUpdate', raw: '1111'}],
      },
      'aa',
    )
    expect(read.commitmentStart).toBe(1076382)
    expect(read.commitmentEnd).toBe(1076392)
    expect(read.spendEvents).toEqual(['abcd', '1111'])
  })

  it('is not fooled by a zero start index', () => {
    // `0` is a legitimate index and the reason the caller must not use it as an "absent" marker.
    const read = readSpendReplayFromTransaction(
      {dustCommitmentStartIndex: 0, dustCommitmentEndIndex: 1, dustLedgerEvents: [spendEvent]},
      'aa',
    )
    expect(read.commitmentStart).toBe(0)
  })

  it('keeps every event, in order, whatever its type', () => {
    // ⚠️ Not only `DustSpendProcessed`. `dustReplayEvents` maintains generations, commitments,
    // nullifiers and dtime updates together, and a batch missing one of a transaction's events leaves
    // the tree short of `commitmentEnd`. Order is the indexer's, which is the ledger's.
    const read = readSpendReplayFromTransaction(
      {
        dustCommitmentStartIndex: 5,
        dustCommitmentEndIndex: 8,
        dustLedgerEvents: [
          {__typename: 'DustGenerationDtimeUpdate', raw: '1111'},
          {__typename: 'ParamChange', raw: '2222'},
          spendEvent,
        ],
      },
      'aa',
    )
    expect(read.spendEvents).toEqual(['1111', '2222', 'abcd'])
  })

  it('keeps several spend events rather than declining them', () => {
    // Two spends in one transaction used to make the whole thing unrepairable, because only one index
    // could be named. Replaying both is what the ledger does.
    const read = readSpendReplayFromTransaction(
      {
        dustCommitmentStartIndex: 5,
        dustCommitmentEndIndex: 7,
        dustLedgerEvents: [spendEvent, {__typename: 'DustSpendProcessed', raw: 'ef01'}],
      },
      'aa',
    )
    expect(read.spendEvents).toEqual(['abcd', 'ef01'])
  })

  it('reports a transaction that published no events as unreplayable, range or no range', () => {
    const read = readSpendReplayFromTransaction(
      {dustCommitmentStartIndex: 5, dustCommitmentEndIndex: 6, dustLedgerEvents: []},
      'aa',
    )
    expect(read.spendEvents).toEqual([])
    // The range is still readable, and saying so separates "no events" from "no range" for the caller.
    expect(read.commitmentStart).toBe(5)
    expect(read.commitmentEnd).toBe(6)
  })

  it('drops an event whose raw bytes are missing rather than carrying a hole', () => {
    // A batch with a gap would replay the wrong commitments; there is no safe placeholder for one.
    const read = readSpendReplayFromTransaction(
      {
        dustCommitmentStartIndex: 5,
        dustCommitmentEndIndex: 6,
        dustLedgerEvents: [{__typename: 'DustSpendProcessed'}, spendEvent],
      },
      'aa',
    )
    expect(read.spendEvents).toEqual(['abcd'])
  })

  it('survives a transaction that is absent or of another kind', () => {
    // `... on RegularTransaction` yields an empty object for any other variant, and the subscription
    // can report a spend whose transaction the indexer declines to expand.
    for (const shape of [null, undefined, {}]) {
      const read = readSpendReplayFromTransaction(shape, 'aa')
      expect(read.commitmentStart).toBeUndefined()
      expect(read.commitmentEnd).toBeUndefined()
      expect(read.spendEvents).toEqual([])
    }
  })
})
