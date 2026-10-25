import {Effect} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'
import {
  clearDustCapabilityCache,
  dustGenerationsArgsFrom,
  dustGenerationsShapeFor,
  dustGenerationsShapeOf,
  unsupportedShapeReason,
} from './dust-indexer-capability'

afterEach(() => clearDustCapabilityCache())

describe('dustGenerationsShapeOf', () => {
  // The two shapes introspected from the live indexers on 2026-08-27.
  it('recognises preprod/mainnet index-range paging', () => {
    expect(dustGenerationsShapeOf(['dustAddress', 'startIndex', 'endIndex'])).toEqual({kind: 'index-range'})
  })

  it('recognises preview block-anchored paging', () => {
    expect(dustGenerationsShapeOf(['dustAddress', 'blockHash', 'dtimeCutoffHeight'])).toEqual({kind: 'block-anchored'})
  })

  it('does not depend on argument order', () => {
    expect(dustGenerationsShapeOf(['endIndex', 'dustAddress', 'startIndex'])).toEqual({kind: 'index-range'})
  })

  // An added optional argument is the ordinary way this API grows; refusing over one would turn a
  // compatible server into an outage.
  it('ignores an extra argument alongside a shape it knows', () => {
    expect(dustGenerationsShapeOf(['dustAddress', 'startIndex', 'endIndex', 'somethingNew'])).toEqual({
      kind: 'index-range',
    })
  })

  // ⚠️ Carries the names, because that is the diagnosis. Today's live failure was legible only
  // because the server said which arguments it wanted.
  it('reports an unknown shape with the arguments the server declared', () => {
    expect(dustGenerationsShapeOf(['dustAddress', 'fromSlot'])).toEqual({
      kind: 'unrecognised',
      args: ['dustAddress', 'fromSlot'],
    })
  })

  it('treats a half-match as unrecognised rather than the shape it half-matches', () => {
    expect(dustGenerationsShapeOf(['dustAddress', 'startIndex'])).toEqual({
      kind: 'unrecognised',
      args: ['dustAddress', 'startIndex'],
    })
  })
})

describe('dustGenerationsArgsFrom', () => {
  const withField = (args: readonly string[]) => ({
    __schema: {
      subscriptionType: {
        fields: [
          {name: 'blocks', args: []},
          {name: 'dustGenerations', args: args.map((name) => ({name}))},
        ],
      },
    },
  })

  it('reads the argument names off the field', () => {
    expect(dustGenerationsArgsFrom(withField(['dustAddress', 'blockHash']))).toEqual(['dustAddress', 'blockHash'])
  })

  // ⚠️ Absent is not unrecognised. An indexer with no such subscription is a different fact from one
  // whose arguments we do not know, and reporting the first as the second would send someone hunting
  // for a shape change that never happened.
  it('is null when the indexer declares no dustGenerations at all', () => {
    expect(dustGenerationsArgsFrom({__schema: {subscriptionType: {fields: [{name: 'blocks', args: []}]}}})).toBeNull()
    expect(dustGenerationsArgsFrom({})).toBeNull()
  })
})

describe('dustGenerationsShapeFor', () => {
  const answer = (args: readonly string[]) =>
    Effect.succeed({
      __schema: {subscriptionType: {fields: [{name: 'dustGenerations', args: args.map((name) => ({name}))}]}},
    })

  it('probes once and remembers the answer', async () => {
    let calls = 0
    const probe = (_url: string) => {
      calls += 1
      return answer(['dustAddress', 'startIndex', 'endIndex'])
    }
    const first = await Effect.runPromise(dustGenerationsShapeFor('https://a', probe))
    const second = await Effect.runPromise(dustGenerationsShapeFor('https://a', probe))
    expect(first).toEqual({kind: 'index-range'})
    expect(second).toEqual({kind: 'index-range'})
    expect(calls).toBe(1)
  })

  it('keys the cache per endpoint, so two networks do not share an answer', async () => {
    const probe = (url: string) =>
      answer(
        url === 'https://preview'
          ? ['dustAddress', 'blockHash', 'dtimeCutoffHeight']
          : ['dustAddress', 'startIndex', 'endIndex'],
      )
    expect(await Effect.runPromise(dustGenerationsShapeFor('https://preview', probe))).toEqual({kind: 'block-anchored'})
    expect(await Effect.runPromise(dustGenerationsShapeFor('https://preprod', probe))).toEqual({kind: 'index-range'})
  })

  // ⚠️ "We could not ask" is not "it answered something we do not implement". Caching a failed probe
  // would pin a transient outage for the life of the process.
  it('does not cache a failed probe', async () => {
    let calls = 0
    const probe = (_url: string) => {
      calls += 1
      return calls === 1 ? Effect.fail(new Error('socket hang up')) : answer(['dustAddress', 'startIndex', 'endIndex'])
    }
    expect(await Effect.runPromise(dustGenerationsShapeFor('https://a', probe))).toBeNull()
    expect(await Effect.runPromise(dustGenerationsShapeFor('https://a', probe))).toEqual({kind: 'index-range'})
    expect(calls).toBe(2)
  })
})

describe('unsupportedShapeReason', () => {
  it('names the arguments an unrecognised shape declared', () => {
    expect(unsupportedShapeReason({kind: 'unrecognised', args: ['dustAddress', 'fromSlot']})).toContain('fromSlot')
  })
})
