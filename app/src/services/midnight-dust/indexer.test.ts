import {describe, expect, it} from 'vitest'
import {snapshotFromBody} from './indexer'

/** The exact body shape the live mainnet indexer returned on 2026-07-28. */
const liveBody = (row: Record<string, unknown>) => ({data: {dustGenerationStatus: [row]}})

describe('snapshotFromBody', () => {
  it('reads a live row', () => {
    const snapshot = snapshotFromBody(
      liveBody({
        cardanoRewardAddress: 'stake1uxjrkxymhcmnglt2cm34samxdq6rgaawyxlddq83kqcdd7qxwaqap',
        registered: true,
        dustAddress: 'mn_dust1wdstt9ra4ff8402wfuy3w7a4aakenv37leysc8fzlkafjswm2xy36d2jhe3',
        nightBalance: '10000000',
        generationRate: '82670000000',
        currentCapacity: '50000000000000000',
        maxCapacity: '50000000000000000',
      }),
    )
    expect(snapshot).toEqual({
      kind: 'ok',
      row: {
        registered: true,
        dustAddress: 'mn_dust1wdstt9ra4ff8402wfuy3w7a4aakenv37leysc8fzlkafjswm2xy36d2jhe3',
        nightBalance: '10000000',
        generationRate: '82670000000',
        currentCapacity: '50000000000000000',
        maxCapacity: '50000000000000000',
      },
    })
  })

  it('accepts numbers where the schema currently sends strings', () => {
    // The scalars are strings today; a schema change to numbers must not silently zero them.
    const snapshot = snapshotFromBody(liveBody({registered: true, nightBalance: 10000000}))
    expect(snapshot).toEqual({kind: 'ok', row: {registered: true, nightBalance: '10000000'}})
  })

  it('omits a null field rather than carrying it through as a value', () => {
    const snapshot = snapshotFromBody(liveBody({registered: true, dustAddress: null, nightBalance: null}))
    expect(snapshot).toEqual({kind: 'ok', row: {registered: true}})
  })

  it('tells "no registration known" apart from "no usable answer"', () => {
    // An empty array is the indexer answering; a malformed body is the indexer not answering.
    // Only the second may fall back to the Cardano-only diagnosis on the grounds of ignorance.
    expect(snapshotFromBody({data: {dustGenerationStatus: []}})).toEqual({kind: 'none'})
    expect(snapshotFromBody({data: {}})).toEqual({kind: 'unavailable'})
    expect(snapshotFromBody({})).toEqual({kind: 'unavailable'})
    expect(snapshotFromBody(null)).toEqual({kind: 'unavailable'})
  })

  it('treats a GraphQL error body as unavailable even when it carries data', () => {
    const body = {errors: [{message: 'boom'}], data: {dustGenerationStatus: [{registered: true}]}}
    expect(snapshotFromBody(body)).toEqual({kind: 'unavailable'})
  })

  it('does not infer registration from a missing flag', () => {
    expect(snapshotFromBody(liveBody({nightBalance: '5'}))).toEqual({
      kind: 'ok',
      row: {registered: false, nightBalance: '5'},
    })
  })
})
