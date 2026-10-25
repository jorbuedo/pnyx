/**
 * Two screens start conversations, so the wording of these five outcomes lives in one place.
 * What is worth asserting is that they stay *distinct* — collapsing any of them either blames the
 * user for our limitation or hides a security event as a network blip.
 */

import {describe, expect, it} from 'vitest'
import type {DmStartFailure} from './dm-start'
import {dmStartFailureKey} from './dm-start-failure-copy'

const KINDS: DmStartFailure[] = [
  {kind: 'chain-unavailable'},
  {kind: 'peer-not-published'},
  {kind: 'peer-no-key-packages'},
  {kind: 'key-package-rejected'},
  {kind: 'failed', cause: new Error('boom')},
]

describe('dmStartFailureKey', () => {
  it('gives every outcome its own sentence', () => {
    const keys = KINDS.map(dmStartFailureKey)
    expect(new Set(keys).size).toBe(KINDS.length)
  })

  it('names the security event as itself, not as a generic failure', () => {
    // A package that did not match the peer's on-chain anchor means the delivery service is
    // substituting packages or their client is broken. It must never read as "try again".
    expect(dmStartFailureKey({kind: 'key-package-rejected'})).toBe('forum.dm.startKeyPackageRejected')
    expect(dmStartFailureKey({kind: 'key-package-rejected'})).not.toBe(dmStartFailureKey({kind: 'failed', cause: 1}))
  })

  it('separates their empty pool from their never having published', () => {
    // "Refill and retry" and "they have not enabled DMs" are different instructions to the user.
    expect(dmStartFailureKey({kind: 'peer-no-key-packages'})).not.toBe(dmStartFailureKey({kind: 'peer-not-published'}))
  })

  it('keeps our own missing chain rail apart from anything of theirs', () => {
    expect(dmStartFailureKey({kind: 'chain-unavailable'})).toBe('forum.dm.startChainUnavailable')
  })
})
