import {describe, expect, it} from 'vitest'

import {
  dueForBackgroundSync,
  enabledAccountsOn,
  freshnessKey,
  MAX_BACKGROUND_PER_TICK,
  STALE_AFTER_MS,
  stalenessOf,
} from './sync-freshness'

const NOW = 1_000_000_000
const wallet = (groupId: string, accountIndex = 0) => ({groupId, accountIndex})

describe('dueForBackgroundSync', () => {
  it('never returns the active wallet, however stale it looks', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('a'), wallet('b')],
      activeKey: freshnessKey('a', 0),
      lastSyncedAt: new Map(),
      now: NOW,
    })

    expect(due).toEqual([wallet('b')])
  })

  it('leaves a recently synced wallet alone', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('a')],
      activeKey: null,
      lastSyncedAt: new Map([[freshnessKey('a', 0), NOW - 1_000]]),
      now: NOW,
    })

    expect(due).toEqual([])
  })

  it('picks up a wallet once it passes the staleness threshold', () => {
    const at = (age: number) => new Map([[freshnessKey('a', 0), NOW - age]])

    expect(
      dueForBackgroundSync({
        candidates: [wallet('a')],
        activeKey: null,
        lastSyncedAt: at(STALE_AFTER_MS - 1),
        now: NOW,
      }),
    ).toEqual([])
    expect(
      dueForBackgroundSync({candidates: [wallet('a')], activeKey: null, lastSyncedAt: at(STALE_AFTER_MS), now: NOW}),
    ).toEqual([wallet('a')])
  })

  // ⚠️ The case that made this exist: a wallet nothing has ever synced. It is the least known, and
  // after a restart it is every wallet at once.
  it('treats a never-synced wallet as due, ahead of any wallet that has synced', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('synced-long-ago'), wallet('never')],
      activeKey: null,
      lastSyncedAt: new Map([[freshnessKey('synced-long-ago', 0), NOW - STALE_AFTER_MS * 100]]),
      now: NOW,
      maxPerTick: 1,
    })

    expect(due).toEqual([wallet('never')])
  })

  it('returns the oldest first', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('recent-ish'), wallet('oldest'), wallet('middle')],
      activeKey: null,
      lastSyncedAt: new Map([
        [freshnessKey('recent-ish', 0), NOW - STALE_AFTER_MS],
        [freshnessKey('oldest', 0), NOW - STALE_AFTER_MS * 10],
        [freshnessKey('middle', 0), NOW - STALE_AFTER_MS * 5],
      ]),
      now: NOW,
      maxPerTick: 3,
    })

    expect(due.map((w) => w.groupId)).toEqual(['oldest', 'middle', 'recent-ish'])
  })

  // Low priority means low priority: these wallets are the ones nobody is looking at, and they must
  // not land N indexer reads on the same tick as the active wallet's own sync.
  it('caps how many it returns per tick', () => {
    const candidates = Array.from({length: 10}, (_, i) => wallet(`w${i}`))
    const due = dueForBackgroundSync({candidates, activeKey: null, lastSyncedAt: new Map(), now: NOW})

    expect(due).toHaveLength(MAX_BACKGROUND_PER_TICK)
  })

  it('returns nothing when the cap is zero', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('a')],
      activeKey: null,
      lastSyncedAt: new Map(),
      now: NOW,
      maxPerTick: 0,
    })

    expect(due).toEqual([])
  })

  it('keeps accounts of one wallet apart', () => {
    const due = dueForBackgroundSync({
      candidates: [wallet('a', 0), wallet('a', 1)],
      activeKey: freshnessKey('a', 0),
      lastSyncedAt: new Map(),
      now: NOW,
      maxPerTick: 5,
    })

    expect(due).toEqual([wallet('a', 1)])
  })
})

describe('stalenessOf', () => {
  it('is null for a wallet that has never synced', () => {
    expect(stalenessOf({groupId: 'a', accountIndex: 0, lastSyncedAt: new Map(), now: NOW})).toBeNull()
  })

  it('reports the age of the last sync', () => {
    const age = stalenessOf({
      groupId: 'a',
      accountIndex: 0,
      lastSyncedAt: new Map([[freshnessKey('a', 0), NOW - 5_000]]),
      now: NOW,
    })

    expect(age).toBe(5_000)
  })

  it('never reports a negative age when a stamp is ahead of the clock', () => {
    const age = stalenessOf({
      groupId: 'a',
      accountIndex: 0,
      lastSyncedAt: new Map([[freshnessKey('a', 0), NOW + 5_000]]),
      now: NOW,
    })

    expect(age).toBe(0)
  })
})

describe('enabledAccountsOn', () => {
  const group = (groupId: string, accounts: readonly {index: number; enabled: boolean}[]) => ({
    groupId,
    chains: new Map([['midnight:preprod', {accounts}]]),
  })

  it('covers every enabled account of every group, not just the first', () => {
    expect(
      enabledAccountsOn(
        [
          group('a', [
            {index: 0, enabled: true},
            {index: 3, enabled: true},
          ]),
          group('b', [{index: 7, enabled: true}]),
        ],
        'midnight:preprod',
      ),
    ).toEqual([
      {groupId: 'a', accountIndex: 0},
      {groupId: 'a', accountIndex: 3},
      {groupId: 'b', accountIndex: 7},
    ])
  })

  it('skips disabled accounts', () => {
    expect(
      enabledAccountsOn(
        [
          group('a', [
            {index: 0, enabled: false},
            {index: 1, enabled: true},
          ]),
        ],
        'midnight:preprod',
      ),
    ).toEqual([{groupId: 'a', accountIndex: 1}])
  })

  it('is empty for a chain a group has no config for', () => {
    expect(enabledAccountsOn([group('a', [{index: 0, enabled: true}])], 'midnight:mainnet')).toEqual([])
  })
})
