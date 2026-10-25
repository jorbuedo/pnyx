import {describe, expect, it} from 'vitest'
import {
  appendLeg,
  canQueue,
  discardLeg,
  MAX_QUEUED_LEGS,
  type SendQueueLeg,
  type SendQueueRequest,
  staleLegIds,
} from './model'

const request = (bodyHex: string): SendQueueRequest => ({
  payload: {_tag: 'CardanoTx', bodyHex, networkId: 0},
  groupId: 'group-1',
})

const leg = (
  legId: string,
  opts: {readonly consumes?: readonly string[]; readonly changeIds?: readonly string[]} = {},
): SendQueueLeg => ({
  legId,
  txHash: `hash-${legId}`,
  request: request(`body-${legId}`),
  consumedUtxoIds: opts.consumes ?? [`utxo-${legId}:0`],
  changeUtxoIds: opts.changeIds ?? [`hash-${legId}:1`],
  changeOutputs: [{index: 1, valueHex: 'aa'}],
  queuedAt: 1_000,
})

describe('appendLeg', () => {
  it('appends onto an empty queue', () => {
    const result = appendLeg([], leg('a'))

    expect(result._tag).toBe('Appended')
    if (result._tag === 'Appended') expect(result.queue.map((l) => l.legId)).toEqual(['a'])
  })

  it('rejects rather than truncating once the cap is reached', () => {
    const full = Array.from({length: MAX_QUEUED_LEGS}, (_, i) => leg(`l${i}`))

    expect(canQueue(full)).toBe(false)
    expect(appendLeg(full, leg('extra'))).toEqual({_tag: 'QueueFull', max: MAX_QUEUED_LEGS})
  })

  it('rejects a duplicate tx hash — re-queueing a build would double-lock its inputs', () => {
    const queued = [leg('a')]
    const sameBuild = {...leg('b'), txHash: 'hash-a'}

    expect(appendLeg(queued, sameBuild)).toEqual({_tag: 'DuplicateLeg', legId: 'a'})
  })
})

describe('discardLeg', () => {
  it('removes only the named leg when nothing depends on it', () => {
    const queue = [leg('a'), leg('b')]

    const {removedLegIds, kept} = discardLeg(queue, 'a')

    expect(removedLegIds).toEqual(['a'])
    expect(kept.map((l) => l.legId)).toEqual(['b'])
  })

  it('cascades to a leg chained onto the discarded one', () => {
    // b spends a's change; c spends b's change.
    const a = leg('a', {changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['hash-a:1'], changeIds: ['hash-b:1']})
    const c = leg('c', {consumes: ['hash-b:1']})

    const {removedLegIds, kept} = discardLeg([a, b, c], 'a')

    expect(removedLegIds).toEqual(['a', 'b', 'c'])
    expect(kept).toEqual([])
  })

  it('leaves an independent leg alone while cascading a dependent one', () => {
    const a = leg('a', {changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['hash-a:1']})
    const independent = leg('c', {consumes: ['confirmed:0']})

    const {removedLegIds, kept} = discardLeg([a, b, independent], 'a')

    expect([...removedLegIds].sort()).toEqual(['a', 'b'])
    expect(kept.map((l) => l.legId)).toEqual(['c'])
  })
})

describe('staleLegIds', () => {
  it('is empty when every input is still available', () => {
    const a = leg('a', {consumes: ['confirmed:0']})

    expect(staleLegIds([a], new Set(['confirmed:0']))).toEqual([])
  })

  it('accepts a leg whose input is produced by an earlier queued leg', () => {
    const a = leg('a', {consumes: ['confirmed:0'], changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['hash-a:1']})

    // 'hash-a:1' does not exist on chain — only leg a produces it.
    expect(staleLegIds([a, b], new Set(['confirmed:0']))).toEqual([])
  })

  it('flags a leg whose input vanished, and cascades to its dependents', () => {
    const a = leg('a', {consumes: ['spent-elsewhere:0'], changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['hash-a:1']})

    expect(staleLegIds([a, b], new Set(['other:0']))).toEqual(['a', 'b'])
  })

  it('keeps earlier legs when only a later one goes stale', () => {
    const a = leg('a', {consumes: ['confirmed:0'], changeIds: ['hash-a:1']})
    const b = leg('b', {consumes: ['gone:0']})

    expect(staleLegIds([a, b], new Set(['confirmed:0']))).toEqual(['b'])
  })

  it('does not treat a later leg change as satisfying an earlier leg input', () => {
    // Order matters: only *earlier* legs can feed a later one.
    const first = leg('first', {consumes: ['hash-second:1']})
    const second = leg('second', {consumes: ['confirmed:0'], changeIds: ['hash-second:1']})

    expect(staleLegIds([first, second], new Set(['confirmed:0']))).toEqual(['first'])
  })
})
