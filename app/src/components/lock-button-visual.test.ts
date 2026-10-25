import {describe, expect, it} from 'vitest'
import {type LockHoldPhase, lockButtonVisual} from './lock-button-visual'

describe('lockButtonVisual', () => {
  it('rests as an open padlock — the header only exists while the app is unlocked', () => {
    expect(lockButtonVisual('idle')).toEqual({icon: 'lockOpen', scale: 1, opacity: 1})
  })

  it('stays open while the hold is still in progress', () => {
    expect(lockButtonVisual('holding').icon).toBe('lockOpen')
  })

  it('shrinks and dims under the finger so the hold is visibly registered', () => {
    const holding = lockButtonVisual('holding')
    expect(holding.scale).toBeLessThan(lockButtonVisual('idle').scale)
    expect(holding.opacity).toBeLessThan(lockButtonVisual('idle').opacity)
  })

  it('snaps shut once the hold commits — the shut padlock is the confirmation', () => {
    expect(lockButtonVisual('committed')).toEqual({icon: 'lock', scale: 1, opacity: 1})
  })

  it('springs back to full scale on commit, so the swap reads as a snap rather than a fade', () => {
    expect(lockButtonVisual('committed').scale).toBeGreaterThan(lockButtonVisual('holding').scale)
    expect(lockButtonVisual('committed').opacity).toBeGreaterThan(lockButtonVisual('holding').opacity)
  })

  it('is total over the phases — every phase yields a registered icon', () => {
    const phases: readonly LockHoldPhase[] = ['idle', 'holding', 'committed']
    for (const phase of phases) {
      const visual = lockButtonVisual(phase)
      expect(['lock', 'lockOpen']).toContain(visual.icon)
      expect(visual.scale).toBeGreaterThan(0)
      expect(visual.opacity).toBeGreaterThan(0)
    }
  })
})
