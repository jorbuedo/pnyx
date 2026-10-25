import {describe, expect, it} from 'vitest'

import {
  DUST_EVENT_BATCH,
  type DustSyncCursor,
  type DustSyncTarget,
  isDustSynced,
  nextDustSyncStep,
} from './dust-sync-plan'

const cursor = (over: Partial<DustSyncCursor> = {}): DustSyncCursor => ({
  generationIndex: 0,
  commitmentIndex: 0,
  eventId: 0,
  ...over,
})

const target = (over: Partial<DustSyncTarget> = {}): DustSyncTarget => ({
  generationTip: 1_000,
  commitmentTip: 900,
  eventTip: 1_200_000,
  firstRelevant: null,
  ...over,
})

describe('nextDustSyncStep', () => {
  it('collapses the whole generation tree for a wallet that holds nothing', () => {
    // The entire saving: 1.2M events are not replayed to discover an empty wallet.
    expect(nextDustSyncStep(cursor(), target())).toEqual({
      kind: 'collapse',
      tree: 'generation',
      start: 0,
      end: 1_000,
    })
  })

  it('collapses only below the first index it holds something at', () => {
    expect(nextDustSyncStep(cursor(), target({firstRelevant: 238_131, generationTip: 240_747}))).toEqual({
      kind: 'collapse',
      tree: 'generation',
      start: 0,
      end: 238_130,
    })
  })

  it('does not collapse when the first relevant index is the very first', () => {
    // Nothing is skippable, so it must go straight to replay rather than emit an empty range.
    const step = nextDustSyncStep(cursor(), target({firstRelevant: 0}))
    expect(step.kind).toBe('replay')
  })

  it('collapses the commitment tree too, but only when nothing is ours', () => {
    const step = nextDustSyncStep(cursor({generationIndex: 1_001}), target())
    expect(step).toEqual({kind: 'collapse', tree: 'commitment', start: 0, end: 900})
  })

  it('does not collapse the commitment tree when this wallet holds DUST', () => {
    // Its commitments are in there; collapsing would discard the witness a spend needs.
    const step = nextDustSyncStep(cursor({generationIndex: 500}), target({firstRelevant: 100}))
    expect(step.kind).not.toBe('collapse')
  })

  it('replays once the trees are caught up', () => {
    const step = nextDustSyncStep(cursor({generationIndex: 1_001, commitmentIndex: 901}), target())
    expect(step).toEqual({kind: 'replay', fromId: 0, limit: DUST_EVENT_BATCH})
  })

  it('replays from the cursor, not from zero', () => {
    // Restarting at zero on every tick is how a resumable sync becomes an unbounded one.
    const step = nextDustSyncStep(cursor({generationIndex: 1_001, commitmentIndex: 901, eventId: 900_000}), target())
    expect(step).toEqual({kind: 'replay', fromId: 900_000, limit: DUST_EVENT_BATCH})
  })

  it('collapses before it replays', () => {
    // Collapsing is cheap and bounded; replay is neither. A plan that replayed first would pay the
    // full cost before discovering it did not have to.
    const step = nextDustSyncStep(cursor(), target({eventTip: 5}))
    expect(step.kind).toBe('collapse')
  })

  it('is done at the tip', () => {
    const step = nextDustSyncStep(cursor({generationIndex: 1_001, commitmentIndex: 901, eventId: 1_200_001}), target())
    expect(step).toEqual({kind: 'done'})
  })

  it('never plans a backwards range', () => {
    // The native side refuses one; planning it would turn a finished sync into an error.
    for (const firstRelevant of [null, 0, 1, 500, 1_000]) {
      for (const generationIndex of [0, 1, 500, 1_000, 1_001]) {
        const step = nextDustSyncStep(cursor({generationIndex}), target({firstRelevant}))
        if (step.kind === 'collapse') expect(step.end).toBeGreaterThanOrEqual(step.start)
      }
    }
  })
})

describe('isDustSynced', () => {
  it('is false for a state that has not caught up', () => {
    // "0 DUST" and "we have not looked" are different facts, and only one justifies refusing a send.
    expect(isDustSynced(cursor(), target())).toBe(false)
  })

  it('is true only past both tips', () => {
    expect(isDustSynced(cursor({generationIndex: 1_001, eventId: 1_200_001}), target())).toBe(true)
  })

  it('is false when the events are current but the tree is not', () => {
    expect(isDustSynced(cursor({generationIndex: 5, eventId: 1_200_001}), target())).toBe(false)
  })

  it('is false when the tree is current but the events are not', () => {
    expect(isDustSynced(cursor({generationIndex: 1_001, eventId: 7}), target())).toBe(false)
  })
})
