import {describe, expect, it} from 'vitest'
import {sectionSync} from './sponsor-client.js'

const progress = (fields: {applied?: bigint; highest?: bigint; complete?: boolean}) => ({
  isStrictlyComplete: () => fields.complete ?? false,
  ...(fields.applied === undefined ? {} : {appliedIndex: fields.applied}),
  ...(fields.highest === undefined ? {} : {highestRelevantWalletIndex: fields.highest}),
})

describe('sectionSync', () => {
  it('reports the lag between applied and highest', () => {
    expect(sectionSync(progress({applied: 100n, highest: 142n, complete: false}))).toEqual({
      complete: false,
      applied: '100',
      highest: '142',
      lag: '42',
    })
  })

  // The SDK leaves these unset for the first ticks of a sync. Reading them unconditionally threw
  // `undefined is not an object (evaluating 'applied.toString')` inside the sync-progress callback,
  // which propagated out of `createSponsorClient` and left the host with no wallet at all.
  it('survives a progress object whose indices are not populated yet', () => {
    expect(() => sectionSync(progress({}))).not.toThrow()
    expect(sectionSync(progress({}))).toEqual({complete: false, applied: null, highest: null, lag: null})
  })

  it('survives one index arriving before the other', () => {
    expect(sectionSync(progress({applied: 7n})).lag).toBeNull()
    expect(sectionSync(progress({highest: 7n})).lag).toBeNull()
  })

  // Null is "not known yet". A fabricated 0 would read as no progress, and as a lag of the whole chain.
  it('never invents a zero for an unknown index', () => {
    const unknown = sectionSync(undefined)
    expect(unknown.applied).toBeNull()
    expect(unknown.lag).toBeNull()
  })

  it('keeps the section verdict even when the indices are missing', () => {
    expect(sectionSync(progress({complete: true})).complete).toBe(true)
  })

  it('clamps a negative lag rather than reporting one', () => {
    expect(sectionSync(progress({applied: 200n, highest: 100n})).lag).toBe('0')
  })
})
