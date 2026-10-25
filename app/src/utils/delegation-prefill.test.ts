import {describe, expect, it} from 'vitest'
import type {LinkAction} from '../services/link-action'
import {delegationPrefillFor} from './delegation-prefill'

const POOL_ID = 'pool1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uuqh3rx6y'
const TARGET = {kind: 'key', hashHex: 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'} as const

describe('delegationPrefillFor', () => {
  it('carries a pool and leaves the DRep alone', () => {
    // `null` is "leave it alone", not "clear it" — a pool link says nothing about
    // a DRep, and clearing one would undelegate a vote the user never mentioned.
    expect(delegationPrefillFor({kind: 'stake-delegation', poolId: POOL_ID}, 'link')).toEqual({
      poolId: POOL_ID,
      drep: null,
      origin: 'link',
    })
  })

  it('carries a DRep target and leaves the pool alone', () => {
    expect(delegationPrefillFor({kind: 'drep-delegation', drepId: 'drep1xyz', target: TARGET}, 'link')).toEqual({
      poolId: null,
      drep: TARGET,
      origin: 'link',
    })
  })

  it('carries the canonical target, never the id as received', () => {
    // The two spellings of one credential must reach the screen as one thing, or
    // "already delegated to this DRep" is wrong.
    const prefill = delegationPrefillFor({kind: 'drep-delegation', drepId: 'DREP1-whatever', target: TARGET})
    expect(prefill?.drep).toEqual(TARGET)
  })

  it('defaults to a scan origin', () => {
    expect(delegationPrefillFor({kind: 'stake-delegation', poolId: POOL_ID})?.origin).toBe('scan')
  })

  it('is null for every action that is not a delegation', () => {
    const others: readonly LinkAction[] = [
      {
        kind: 'payment-request',
        address: 'addr1x',
        lovelace: 1n,
        message: undefined,
        paymentId: undefined,
        asksForAssets: false,
      },
      {kind: 'dapp', url: 'https://example.com', host: 'example.com'},
      {kind: 'multisig-invite'},
    ]
    for (const action of others) expect(delegationPrefillFor(action, 'link')).toBeNull()
  })
})
