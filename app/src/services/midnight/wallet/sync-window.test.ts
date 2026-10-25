import {describe, expect, it} from 'vitest'

import {type ShieldedBirthday, syncWindow} from './sync-window'

const created = (height: number): ShieldedBirthday => ({height, origin: 'created'})

describe('syncWindow', () => {
  it('starts a first sync near the tip when the wallet has no birthday', () => {
    // A phone walking a whole chain is not a sync, it is a hang.
    expect(syncWindow({tip: 1_000, cursor: undefined, window: 60})).toEqual({
      fromHeight: 941,
      toHeight: 1_000,
      collapseFirst: true,
    })
  })

  it('starts a first sync at the birthday, however far back it is', () => {
    // The height the seed was created at. Nothing it can hold is older, so a walk from here is
    // complete — which the tip window above is not.
    expect(syncWindow({tip: 1_000, cursor: undefined, window: 60, birthday: created(400)})).toEqual({
      fromHeight: 400,
      toHeight: 459,
      collapseFirst: true,
    })
  })

  it('resumes at cursor + 1, so no block is applied twice', () => {
    // Applying a block twice puts our coins at indices the chain gave other commitments, and every proof
    // built from that tree then fails.
    expect(syncWindow({tip: 1_000, cursor: 900, window: 60})).toEqual({
      fromHeight: 901,
      toHeight: 960,
      collapseFirst: false,
    })
  })

  it('does not collapse again once a cursor exists, whatever the birthday says', () => {
    // The tree already covers everything up to the cursor. Collapsing over it would discard the leaves
    // it holds, ours among them.
    expect(syncWindow({tip: 1_000, cursor: 900, window: 60, birthday: created(400)})?.collapseFirst).toBe(false)
  })

  it('stops at the tip rather than running past it', () => {
    expect(syncWindow({tip: 910, cursor: 900, window: 60})).toEqual({
      fromHeight: 901,
      toHeight: 910,
      collapseFirst: false,
    })
  })

  it('has nothing to do when the cursor is already at the tip', () => {
    expect(syncWindow({tip: 900, cursor: 900, window: 60})).toBeNull()
  })

  it('has nothing to do when the cursor is somehow ahead of the tip', () => {
    // A rollback or a switched indexer. Returning a backwards range would rescan blocks the state has
    // already applied.
    expect(syncWindow({tip: 800, cursor: 900, window: 60})).toBeNull()
  })

  it('has nothing to do when the birthday is ahead of the tip', () => {
    // A wallet created against one indexer and synced against another that is behind. Walking a
    // backwards range would be worse than waiting.
    expect(syncWindow({tip: 500, cursor: undefined, window: 60, birthday: created(900)})).toBeNull()
  })

  it('never starts below the first block on a short chain', () => {
    expect(syncWindow({tip: 10, cursor: undefined, window: 60})).toEqual({
      fromHeight: 1,
      toHeight: 10,
      collapseFirst: true,
    })
  })

  it('clamps a birthday of zero to the first block', () => {
    // Height 0 is not a block. Asking the indexer for one is a query that answers nothing, and the
    // collapse that precedes it would be over the range [0, -1].
    expect(syncWindow({tip: 100, cursor: undefined, window: 60, birthday: created(0)})?.fromHeight).toBe(1)
  })
})
