import {describe, expect, it} from 'vitest'
import {canRetryCircleDeploy} from './chain-retry'

const base = {isFounder: true, status: 'failed', hasForumRoot: true, isRetrying: false} as const

describe('canRetryCircleDeploy', () => {
  it('offers the retry to a founder whose deploy failed', () => {
    expect(canRetryCircleDeploy(base)).toBe(true)
  })

  // The gate that matters: a non-founder retry derives a different `founderAuth`, so it would deploy a
  // second contract at a different address and leave this circle's row pointing at it.
  it('refuses anyone but the founder', () => {
    expect(canRetryCircleDeploy({...base, isFounder: false})).toBe(false)
  })

  it.each(['pending', 'confirmed', undefined] as const)('offers nothing when the status is %s', (status) => {
    expect(canRetryCircleDeploy({...base, status})).toBe(false)
  })

  // Without a forumRoot there is no persona to derive, so the retry could not build the same deploy.
  it('refuses a session that cannot derive a persona', () => {
    expect(canRetryCircleDeploy({...base, hasForumRoot: false})).toBe(false)
  })

  it('does not queue a second attempt while one is in flight', () => {
    expect(canRetryCircleDeploy({...base, isRetrying: true})).toBe(false)
  })
})
