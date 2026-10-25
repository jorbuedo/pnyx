import {describe, expect, it} from 'vitest'
import {landingForPushIntent} from './push-intent-landing'

const T = 1_700_000_000_000

describe('landingForPushIntent', () => {
  it('card-3ds routes to /card (auth flow consumes the intent on ready)', () => {
    expect(landingForPushIntent({kind: 'card-3ds', txId: 'tx', createdAtMs: T})).toBe('/community')
  })

  it('card-activity routes to /card', () => {
    expect(landingForPushIntent({kind: 'card-activity', activityId: 'a', createdAtMs: T})).toBe('/community')
  })

  it('card routes to /card', () => {
    expect(landingForPushIntent({kind: 'card', createdAtMs: T})).toBe('/community')
  })

  it('settings routes to /settings', () => {
    expect(landingForPushIntent({kind: 'settings', createdAtMs: T})).toBe('/menu')
  })
})
