/**
 * Drift guard: `SETTLEMENT_KINDS_FOR_ACTION` must stay correct for the (action, ref-kind) pairs the
 * app actually submits — even though nothing consults it yet.
 *
 * ⚠️ **This exists because the map was wrong and nobody could tell.** `settlementMismatch` has no
 * production caller, so the map has never been exercised by anything; when it was checked against
 * the app's real submit call sites on 2026-09-12, two of the six live pairs would have been refused
 * — a proposal deploy (`deploy` allowed only `circle`) and every `setInviteAuthority` (mapped to
 * "settles nothing" while the app submits it under `invite-authority`). Both postdated the map.
 *
 * An unused map rots silently, and the rot only surfaces as an outage the day someone wires it up.
 * These pairs are read off `app/src/services/pnyx-proving.ts`'s `postChainSubmit` calls; add
 * a row here whenever a new one appears there.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {DEPLOY_ACTION, SETTLEMENT_KINDS_FOR_ACTION, settlementMismatch} from './sponsorship'

/** Every (action, ref kind) the app submits today, from its own `postChainSubmit` call sites. */
const LIVE_PAIRS: ReadonlyArray<readonly [action: string, kind: string]> = [
  [DEPLOY_ACTION, 'circle'],
  // Creating a proposal is a deploy — there is no `createProposal` circuit since the 2026-08-25 split.
  [DEPLOY_ACTION, 'proposal'],
  ['join', 'membership'],
  ['setInvite', 'invite'],
  // The one the service itself calls, as the circle's delegated attestor.
  ['issueInvite', 'invite'],
  ['setInviteAuthority', 'invite-authority'],
]

describe('the settlement map covers what the app actually submits', () => {
  it.each(LIVE_PAIRS)('accepts %s settling a %s ref', (action, kind) => {
    expect(settlementMismatch(action, kind)).toBeUndefined()
  })

  it('still refuses a ref kind the action cannot settle', () => {
    // The check's whole purpose: a join must not be able to settle a circle's ChainRef.
    expect(settlementMismatch('join', 'circle')).toMatch(/cannot settle/)
  })

  it('still refuses an action it has never heard of', () => {
    expect(settlementMismatch('rotateAdmin', 'circle')).toMatch(/no settlement mapping/)
  })

  it('names no action that is not a real entry point or the deploy sentinel', () => {
    // `createProposal` lived here for weeks after its circuit stopped existing. A name in this map
    // that nothing can ever submit is the same rot in the other direction.
    expect(Object.keys(SETTLEMENT_KINDS_FOR_ACTION)).not.toContain('createProposal')
  })
})
