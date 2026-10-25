import {describe, expect, it} from 'vitest'

import {dustStaleness} from './dust-staleness'

describe('dustStaleness', () => {
  it('reports never when no DUST state has been synced', () => {
    expect(dustStaleness({dustSyncedAt: undefined, dustWatermark: 5, unshieldedWatermark: 9})).toBe('never')
  })

  it('reports current when nothing has happened since the sync', () => {
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 9, unshieldedWatermark: 9})).toBe('current')
  })

  it('reports activity when unshielded outputs moved past the sync', () => {
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 9, unshieldedWatermark: 10})).toBe('activity')
  })

  // Age alone proves nothing: `dustBalance(state, now)` recomputes accrual locally, so a wallet synced
  // long ago still shows the right number. Only the UTxO set can go wrong.
  it('does not call a state stale merely for being old', () => {
    expect(dustStaleness({dustSyncedAt: 1, dustWatermark: 9, unshieldedWatermark: 9})).toBe('current')
  })

  // A missing watermark is not a zero one. Zero means "no unshielded activity seen", which is a real
  // answer; absent means the state predates the field, and reporting that as stale would nag forever.
  it('reports unknown rather than stale when either watermark is missing', () => {
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: undefined, unshieldedWatermark: 9})).toBe(
      'unknown',
    )
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 9, unshieldedWatermark: undefined})).toBe(
      'unknown',
    )
  })

  it('treats a zero watermark as a real value on both sides', () => {
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 0, unshieldedWatermark: 0})).toBe('current')
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 0, unshieldedWatermark: 1})).toBe('activity')
  })

  // A watermark that went backwards is a re-sync from scratch, not new activity — reporting it as
  // activity would ask for a refresh that changes nothing.
  it('does not report activity when the unshielded watermark went backwards', () => {
    expect(dustStaleness({dustSyncedAt: 1_700_000_000, dustWatermark: 9, unshieldedWatermark: 4})).toBe('current')
  })
})
