import type {ChainSyncState, ChainWalletKey} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {type ChainSyncOutcome, reconcileRefreshedSyncStates} from './sync-state-reconcile'

// Regression: a failed pull-to-refresh while offline must NOT reset a
// failing chain to idle (or clear its connectivity error), or the Limited
// connectivity banner flips off / shows the wrong banner.

const GROUP = 'g1'
const ADA = 'cardano'
const ETH = 'ethereum'
const key = (chain: string) => `${GROUP}:${chain}` as ChainWalletKey

const ok: ChainSyncOutcome = {ok: true}
const offline: ChainSyncOutcome = {ok: false, message: 'Network request failed'}

describe('reconcileRefreshedSyncStates', () => {
  it('resets a synced chain to idle and clears its error', () => {
    const prev = new Map<ChainWalletKey, ChainSyncState>([[key(ADA), {status: 'error', lastError: 'boom'}]])
    const next = reconcileRefreshedSyncStates({prev, groupId: GROUP, chainIds: [ADA], results: [ok], now: 100})
    expect(next.get(key(ADA))).toEqual({status: 'idle', lastChanged: 100, lastError: undefined})
  })

  it('marks a failed chain error with this attempt’s message (offline), preserving other fields', () => {
    const prev = new Map<ChainWalletKey, ChainSyncState>([
      [key(ADA), {status: 'error', lastError: 'Network request failed', lastSynced: 50}],
    ])
    const next = reconcileRefreshedSyncStates({prev, groupId: GROUP, chainIds: [ADA], results: [offline], now: 100})
    expect(next.get(key(ADA))).toEqual({
      status: 'error',
      lastError: 'Network request failed',
      lastSynced: 50,
      lastChanged: 100,
    })
  })

  it('overwrites a stale server error with the fresh connectivity error after going offline', () => {
    // Was a server outage (HTTP 503 → backend-failing banner); device then goes
    // offline and the refresh rejects with a connectivity error. The new message
    // must replace the stale one so isAnyChainOffline flips true.
    const prev = new Map<ChainWalletKey, ChainSyncState>([[key(ADA), {status: 'error', lastError: 'HTTP 503'}]])
    const next = reconcileRefreshedSyncStates({prev, groupId: GROUP, chainIds: [ADA], results: [offline], now: 100})
    expect(next.get(key(ADA))?.lastError).toBe('Network request failed')
  })

  it('splits a mixed group: cache-backed success → idle, failing chain → error', () => {
    const prev = new Map<ChainWalletKey, ChainSyncState>([
      [key(ETH), {status: 'idle'}],
      [key(ADA), {status: 'idle'}],
    ])
    const next = reconcileRefreshedSyncStates({
      prev,
      groupId: GROUP,
      chainIds: [ETH, ADA],
      results: [ok, {ok: false, message: 'failed to fetch'}],
      now: 100,
    })
    expect(next.get(key(ETH))?.status).toBe('idle')
    expect(next.get(key(ADA))?.status).toBe('error')
    expect(next.get(key(ADA))?.lastError).toBe('failed to fetch')
  })

  it('bumps lastChanged for every chain so portfolio consumers re-fetch', () => {
    const next = reconcileRefreshedSyncStates({
      prev: new Map(),
      groupId: GROUP,
      chainIds: [ETH, ADA],
      results: [ok, offline],
      now: 100,
    })
    expect(next.get(key(ETH))?.lastChanged).toBe(100)
    expect(next.get(key(ADA))?.lastChanged).toBe(100)
  })

  it('falls back to the prior lastError when a failure carries no message', () => {
    const prev = new Map<ChainWalletKey, ChainSyncState>([[key(ADA), {status: 'error', lastError: 'ENOTFOUND'}]])
    const next = reconcileRefreshedSyncStates({
      prev,
      groupId: GROUP,
      chainIds: [ADA],
      results: [{ok: false, message: ''}],
      now: 100,
    })
    expect(next.get(key(ADA))?.lastError).toBe('ENOTFOUND')
  })
})
