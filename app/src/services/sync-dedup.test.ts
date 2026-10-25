import {TX_FETCH_MODE} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {coveringSyncKey, syncDedupKey} from './sync-dedup'

const inFlight = (...keys: readonly string[]) => new Set(keys)
const G = 'group-1'
const C = 'cardano:mainnet'

describe('coveringSyncKey', () => {
  it('joins an identical request already running', () => {
    const key = syncDedupKey(G, C, TX_FETCH_MODE.ALL)
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.ALL}, inFlight(key))).toBe(key)
  })

  it('lets a recent request join an in-flight full sync', () => {
    // The launch case: the selection effect asks for `recent` a millisecond after
    // the scheduler asked for `all`. Full history already covers the tip check.
    const full = syncDedupKey(G, C, TX_FETCH_MODE.ALL)
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.RECENT}, inFlight(full))).toBe(full)
  })

  it('never lets a full request join an in-flight recent one', () => {
    // The asymmetry that matters: absorbed here, full history would never run and
    // the activity screen would stay on the recent page.
    const recent = syncDedupKey(G, C, TX_FETCH_MODE.RECENT)
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.ALL}, inFlight(recent))).toBeNull()
  })

  it('does not join another wallet or another chain', () => {
    const otherGroup = syncDedupKey('group-2', C, TX_FETCH_MODE.ALL)
    const otherChain = syncDedupKey(G, 'midnight:mainnet', TX_FETCH_MODE.ALL)
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.RECENT}, inFlight(otherGroup))).toBeNull()
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.RECENT}, inFlight(otherChain))).toBeNull()
  })

  it('starts a sync when nothing is running', () => {
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.RECENT}, inFlight())).toBeNull()
    expect(coveringSyncKey({groupId: G, chainId: C, mode: TX_FETCH_MODE.ALL}, inFlight())).toBeNull()
  })
})
