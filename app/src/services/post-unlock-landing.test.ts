import {describe, expect, it} from 'vitest'

import type {PendingPushIntent} from './pending-push-intent'
import {FIRST_RUN_LANDING, postUnlockLanding} from './post-unlock-landing'

describe('postUnlockLanding', () => {
  it('returns to the tab the user was last on', () => {
    // The behaviour this rule exists for: a user who lives in Wallets used to be moved to Community by
    // every unlock, and a network switch re-locks, so that was constant.
    expect(postUnlockLanding({pendingIntent: null, lastHomeTab: 'wallets'})).toBe('/wallets')
    expect(postUnlockLanding({pendingIntent: null, lastHomeTab: 'id'})).toBe('/id')
    expect(postUnlockLanding({pendingIntent: null, lastHomeTab: 'community'})).toBe('/community')
  })

  it('falls back only when no tab is known', () => {
    expect(postUnlockLanding({pendingIntent: null, lastHomeTab: null})).toBe(FIRST_RUN_LANDING)
  })

  it('lets a push intent win, because the notification is why the app was opened', () => {
    const intent = {kind: 'settings'} as PendingPushIntent
    expect(postUnlockLanding({pendingIntent: intent, lastHomeTab: 'wallets'})).toBe('/menu')
  })
})
