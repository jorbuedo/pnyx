// Where a review ticket is opened. Pinned against the route files, because `router.push(… as never)`
// makes a wrong path a rendered screen rather than a type error.
import {existsSync} from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {type ReviewChain, reviewRouteFor} from './review-route'

const APP_DIR = path.resolve(__dirname, '../../../app')

describe('reviewRouteFor', () => {
  it('sends a Cardano ticket to the Cardano review and a Midnight one to the Midnight review', () => {
    expect(reviewRouteFor('cardano', 'abc')).toBe('/wallet/review-tx?ticket=abc')
    expect(reviewRouteFor('midnight', 'mnt-1')).toBe('/wallet/midnight/transaction?dapp=mnt-1')
  })

  /**
   * ⚠️ The half a type cannot check, and the defect that shipped on 2026-08-28: a Midnight ticket
   * opened on the Cardano route rendered "Transaction failed" for a correct transaction. A path that
   * does not exist would do the same, silently, because the router call is cast.
   */
  it('names a route file that exists for every chain', () => {
    for (const chain of ['cardano', 'midnight'] as ReviewChain[]) {
      const route = reviewRouteFor(chain, 'x').split('?')[0] ?? ''
      const file = path.join(APP_DIR, `${route}.tsx`)
      expect(existsSync(file), `${chain} → ${route} has no route file at ${file}`).toBe(true)
    }
  })

  // The two registries have separate id spaces, so the parameter name is part of the address.
  it('uses each review’s own query parameter', () => {
    expect(reviewRouteFor('cardano', 'x')).toContain('ticket=')
    expect(reviewRouteFor('midnight', 'x')).toContain('dapp=')
  })
})
