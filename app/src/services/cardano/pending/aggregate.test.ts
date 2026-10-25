import {describe, expect, it} from 'vitest'
import {type ContinuationRecord, createContinuation} from '../continuation/record'
import type {PendingCosign} from '../cosign/registry'
import type {EnvelopeSigner, TxEnvelope} from '../cosign/types'
import {aggregatePending, type PendingContinuationItem, type PendingCosignItem} from './aggregate'

const signer = (id: string, signed: boolean): EnvelopeSigner => ({id, name: id, keyHashHex: `${id}hash`, signed})

const envelope = (createdAt: string, signers: readonly EnvelopeSigner[]): TxEnvelope => ({
  version: 1,
  chainId: 'cardano:preprod',
  createdAt,
  createdBy: 'me',
  kind: 'multisig',
  bodyHex: 'aa',
  nativeScriptHexes: [],
  networkId: 0,
  accountIndex: 0,
  keyIndexes: [0],
  signers,
  witnesses: [],
})

const cosign = (id: string, createdAt: string, signers: readonly EnvelopeSigner[]): PendingCosign => ({
  id,
  groupId: 'g1',
  envelope: envelope(createdAt, signers),
})

describe('aggregatePending', () => {
  it('merges cosign + continuation into a newest-first list', () => {
    const c1 = cosign('c1', '2026-07-10T00:00:00.000Z', [signer('a', true), signer('b', false)])
    const c2 = cosign('c2', '2026-07-12T00:00:00.000Z', [signer('a', false), signer('b', false)])
    // continuation id with a time prefix between the two cosign timestamps
    const between = Date.parse('2026-07-11T00:00:00.000Z')
    const cont: ContinuationRecord = createContinuation({
      groupId: 'g1',
      continuationId: `${between.toString(36)}-1`,
      context: 'cardano.signAll',
      expectedStepCount: 2,
    })

    const items = aggregatePending([c1, c2], [cont])

    expect(items.map((i) => i.id)).toEqual(['c2', cont.continuationId, 'c1'])
    expect(items.map((i) => i.kind)).toEqual(['cosign', 'continuation', 'cosign'])
  })

  it('derives quorum status for cosign items', () => {
    const c1 = cosign('c1', '2026-07-10T00:00:00.000Z', [signer('a', true), signer('b', false)])
    const [item] = aggregatePending([c1], [])
    const cosignItem = item as PendingCosignItem
    expect(cosignItem.kind).toBe('cosign')
    expect(cosignItem.status.required).toBe(2)
    expect(cosignItem.status.signed).toBe(1)
    expect(cosignItem.status.meetsQuorum).toBe(false)
    expect(cosignItem.canResume).toBe(true)
  })

  it('drops completed continuations and keeps resumable ones', () => {
    const done: ContinuationRecord = {
      ...createContinuation({groupId: 'g1', continuationId: 'done-1', context: 'x', expectedStepCount: 1}),
      status: 'completed',
      signedSteps: [{stepId: '0', txHash: 'h'}],
      currentStepIndex: 1,
    }
    const pending = createContinuation({groupId: 'g1', continuationId: 'live-1', context: 'x', expectedStepCount: 2})
    const items = aggregatePending([], [done, pending])
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('live-1')
  })

  // A continuation stashes *unsigned* requests, so signing them from the inbox
  // would sign bytes read out of storage with nothing shown to the user. It is
  // never resumable from here; `hasUnbroadcastLegs` still reports that the work
  // is outstanding so the row can say so and offer a rebuild. See the module note.
  it('never marks a continuation resumable, whatever payload it carries', () => {
    const withPayload = createContinuation({
      groupId: 'g1',
      continuationId: 'p-1',
      context: 'x',
      expectedStepCount: 2,
      contextData: {
        requests: [
          {groupId: 'g1', payload: {}},
          {groupId: 'g1', payload: {}},
        ],
      },
    })
    const withoutPayload = createContinuation({
      groupId: 'g1',
      continuationId: 'q-1',
      context: 'x',
      expectedStepCount: 2,
    })

    const items = aggregatePending([], [withPayload, withoutPayload])
    const byId = new Map(items.map((i) => [i.id, i as PendingContinuationItem]))
    expect(byId.get('p-1')?.canResume).toBe(false)
    expect(byId.get('q-1')?.canResume).toBe(false)
    // ...but the outstanding-work signal still distinguishes them.
    expect(byId.get('p-1')?.hasUnbroadcastLegs).toBe(true)
    expect(byId.get('q-1')?.hasUnbroadcastLegs).toBe(false)
  })

  it('the list length is the badge count (all cosigns + resumable continuations)', () => {
    const c1 = cosign('c1', '2026-07-10T00:00:00.000Z', [signer('a', false)])
    const pending = createContinuation({groupId: 'g1', continuationId: 'live-1', context: 'x', expectedStepCount: 2})
    const done: ContinuationRecord = {
      ...createContinuation({groupId: 'g1', continuationId: 'done-1', context: 'x', expectedStepCount: 1}),
      status: 'completed',
      signedSteps: [{stepId: '0', txHash: 'h'}],
      currentStepIndex: 1,
    }
    expect(aggregatePending([c1], [pending, done])).toHaveLength(2)
  })
})
