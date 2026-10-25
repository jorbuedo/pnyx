import {type Provider, TransactionHash} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import {
  backfillComplete,
  canAdvanceWatermark,
  canSkipHistoryWalk,
  FULL_WALK_INTERVAL_MS,
  type HistoryReach,
  historyWalkPlan,
  INITIAL_WINDOW_BLOCKS,
  MAX_WINDOW_BLOCKS,
  newestWatermark,
  nextHistoryCheckpoint,
  REORG_MARGIN_BLOCKS,
  ROLLBACK_BOUND_BLOCKS,
  type SyncWatermark,
  shouldProbeHistoryFloor,
  watermarkChanged,
  watermarkOf,
  windowSpanFor,
} from './sync-decision'

/**
 * ⚠️ A REAL `TransactionHash`, not a branded hex string. `watermarkOf` takes Evolution's
 * `IndexedTxRef` now and converts at the edge, because a watermark is persisted — so a fixture
 * built from hex would be testing a shape the provider does not produce.
 */
const ref = (txHash: string, blockHeight?: number): Provider.IndexedTxRef =>
  blockHeight === undefined
    ? {txHash: TransactionHash.fromHex(txHash)}
    : {txHash: TransactionHash.fromHex(txHash), blockHeight}

describe('watermarkOf', () => {
  it('takes the newest (first) ref — the provider returns newest-first', () => {
    expect(
      watermarkOf([
        ref('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        ref('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 99),
      ]),
    ).toEqual({
      newestTxHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      newestBlockHeight: 100,
    })
  })

  it('returns null for an empty history', () => {
    expect(watermarkOf([])).toBeNull()
  })

  it('normalizes a missing block height to null', () => {
    expect(watermarkOf([ref('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')])).toEqual({
      newestTxHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      newestBlockHeight: null,
    })
  })
})

describe('watermarkChanged', () => {
  const wm = (h: string, b: number | null): SyncWatermark => ({newestTxHash: h, newestBlockHeight: b})

  it('is true on the first sync (no prior watermark)', () => {
    expect(watermarkChanged(null, wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100))).toBe(
      true,
    )
  })

  it('is false when the newest tx is unchanged (the gate that skips refetch)', () => {
    expect(
      watermarkChanged(
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
      ),
    ).toBe(false)
  })

  it('is true when the newest tx hash differs', () => {
    expect(
      watermarkChanged(
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100),
      ),
    ).toBe(true)
  })

  it('is true when the block height differs (e.g. a rollback/re-org at the same hash)', () => {
    expect(
      watermarkChanged(
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 101),
      ),
    ).toBe(true)
  })

  it('is true when the probe unexpectedly reports no history', () => {
    expect(watermarkChanged(wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100), null)).toBe(
      true,
    )
  })
})

describe('newestWatermark', () => {
  const wm = (h: string, b: number | null): SyncWatermark => ({newestTxHash: h, newestBlockHeight: b})

  it('picks the highest block height across batches', () => {
    expect(
      newestWatermark([
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 140),
        wm('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 3),
      ]),
    ).toEqual(wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 140))
  })

  it('is order-independent — a flapping result would refetch on every sync', () => {
    const batches = [
      wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
      wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 140),
      wm('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 3),
    ]
    expect(newestWatermark(batches)).toEqual(newestWatermark([...batches].reverse()))
  })

  it('breaks a height tie deterministically rather than by position', () => {
    expect(
      newestWatermark([
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
        wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100),
      ]),
    ).toEqual(wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100))
    expect(
      newestWatermark([
        wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100),
        wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100),
      ]),
    ).toEqual(wm('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100))
  })

  it('never lets a height-less entry outrank one with a height', () => {
    expect(
      newestWatermark([wm('zz', null), wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1)]),
    ).toEqual(wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1))
    expect(
      newestWatermark([wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1), wm('zz', null)]),
    ).toEqual(wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1))
  })

  it('is null only when every batch reports no history', () => {
    expect(newestWatermark([null, null])).toBeNull()
    expect(newestWatermark([])).toBeNull()
    expect(
      newestWatermark([null, wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null)]),
    ).toEqual(wm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null))
  })
})

describe('canSkipHistoryWalk', () => {
  const args = (over: Partial<Parameters<typeof canSkipHistoryWalk>[0]> = {}) => ({
    newestTxHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    checkpointTxHash: 'aa'.repeat(32),
    hasStoredRows: true,
    backfillComplete: true,
    ...over,
  })

  it('skips when the checkpoint matches, rows are stored and the backfill reached the bottom', () => {
    expect(canSkipHistoryWalk(args())).toBe(true)
  })

  it('walks when the backfill has not reached the bottom, however current the newest hash is', () => {
    expect(canSkipHistoryWalk(args({backfillComplete: false}))).toBe(false)
  })

  it('walks when the checkpoint matches but no row is stored (dropped table, live checkpoint)', () => {
    expect(canSkipHistoryWalk(args({hasStoredRows: false}))).toBe(false)
  })

  it('walks when the account has a newer tx than the checkpoint', () => {
    expect(
      canSkipHistoryWalk(args({newestTxHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'})),
    ).toBe(false)
  })

  it('walks when there is no checkpoint yet', () => {
    expect(canSkipHistoryWalk(args({checkpointTxHash: undefined}))).toBe(false)
  })

  it('walks when the newest hash is unknown — an unanswered probe proves nothing', () => {
    expect(canSkipHistoryWalk(args({newestTxHash: undefined, checkpointTxHash: undefined}))).toBe(false)
  })
})

describe('canAdvanceWatermark', () => {
  const wm = (hash: string, height: number): SyncWatermark => ({newestTxHash: hash, newestBlockHeight: height})

  it('advances when the refetch actually changed the confirmed set', () => {
    expect(canAdvanceWatermark({probed: true, previous: wm('a', 1), setChanged: true})).toBe(true)
  })

  it('refuses to advance past a change the fetch did not bring in', () => {
    // The probe reads the transaction index and the fetch reads the UTxO index.
    // They do not update together, so the probe can see a spend the fetch cannot
    // yet — and a watermark moved past it suppresses every future refetch,
    // freezing the balance until the next transaction. Observed on preprod.
    expect(canAdvanceWatermark({probed: true, previous: wm('a', 1), setChanged: false})).toBe(false)
  })

  it('advances on the first sync even with nothing changed, so an idle wallet stops refetching', () => {
    expect(canAdvanceWatermark({probed: true, previous: null, setChanged: false})).toBe(true)
  })

  it('never advances without a fresh probe — there is nothing to advance to', () => {
    expect(canAdvanceWatermark({probed: false, previous: wm('a', 1), setChanged: true})).toBe(false)
  })
})

const NOW = 1_700_000_000_000
const complete = (over: Partial<HistoryReach> = {}): HistoryReach => ({
  newestBlockHeight: 10_000,
  complete: true,
  fullWalkAt: NOW - 1000,
  // A finished backfill is what `complete` now *means*: enumerated down past the account's first tx.
  oldestEnumeratedHeight: 500,
  firstTxHeight: 500,
  ...over,
})

describe('windowSpanFor', () => {
  // Cost is set by depth, not span — the same 1,000-block window measured 1.4s near the tip and 30.7s
  // three million blocks down. So windows widen as the walk descends, making deep requests rarer.
  it('keeps the initial span near the tip', () => {
    expect(windowSpanFor(0)).toBe(INITIAL_WINDOW_BLOCKS)
    expect(windowSpanFor(INITIAL_WINDOW_BLOCKS)).toBe(INITIAL_WINDOW_BLOCKS)
  })

  it('widens with depth', () => {
    expect(windowSpanFor(1_000_000)).toBeGreaterThan(INITIAL_WINDOW_BLOCKS)
    expect(windowSpanFor(4_000_000)).toBeGreaterThan(windowSpanFor(1_000_000))
  })

  it('caps, so one window can never outgrow a page', () => {
    expect(windowSpanFor(100_000_000)).toBe(MAX_WINDOW_BLOCKS)
  })

  // The property that makes a backfill finite: descending by these spans reaches the floor in a number
  // of steps logarithmic in the history's length, not linear. 22 windows for the account measured.
  it('reaches the floor of a 6.66M-block history in a couple of dozen windows', () => {
    let cursor = 13_863_222
    const floor = 7_205_959
    let windows = 0
    while (cursor > floor && windows < 500) {
      cursor -= windowSpanFor(13_863_222 - cursor)
      windows += 1
    }
    expect(cursor).toBeLessThanOrEqual(floor)
    expect(windows).toBeLessThan(40)
  })
})

describe('backfillComplete', () => {
  it('is false until something has been enumerated', () => {
    expect(backfillComplete(null)).toBe(false)
    expect(backfillComplete({firstTxHeight: 100})).toBe(false)
  })

  it("is true once the walk has passed the account's oldest transaction", () => {
    expect(backfillComplete({oldestEnumeratedHeight: 100, firstTxHeight: 100})).toBe(true)
    expect(backfillComplete({oldestEnumeratedHeight: 99, firstTxHeight: 100})).toBe(true)
    expect(backfillComplete({oldestEnumeratedHeight: 101, firstTxHeight: 100})).toBe(false)
  })

  // Without a floor the only proof of completeness is having reached the beginning of the chain.
  it('needs block zero when the floor is unknown', () => {
    expect(backfillComplete({oldestEnumeratedHeight: 1})).toBe(false)
    expect(backfillComplete({oldestEnumeratedHeight: 0})).toBe(true)
  })
})

describe('historyWalkPlan', () => {
  const TOP = 1_000_000

  it('starts at the newest window on a first sync', () => {
    expect(historyWalkPlan({checkpoint: null, hasStoredRows: false, newestTxHeight: TOP, nowMs: NOW})).toEqual({
      afterBlock: TOP - INITIAL_WINDOW_BLOCKS,
      beforeBlock: undefined,
      reason: 'first-sync',
    })
  })

  // ⚠️ The checkpoint lives in a key-value store and the rows live in the tx table, so the table can be
  // dropped while the checkpoint survives. An incremental plan would then fetch only recent
  // transactions and mark *itself* complete — a permanently truncated history with nothing to signal it.
  it('restarts at the newest window when a walk that stored rows now finds none', () => {
    expect(
      historyWalkPlan({
        checkpoint: complete({txCount: 42}),
        hasStoredRows: false,
        newestTxHeight: TOP,
        nowMs: NOW,
      }),
    ).toEqual({
      afterBlock: TOP - INITIAL_WINDOW_BLOCKS,
      beforeBlock: undefined,
      reason: 'no-stored-rows',
    })
  })

  // ⚠️ An account with no transactions has an empty table by definition. Reading that as a dropped
  // table left a freshly restored empty wallet replanning `no-stored-rows` for ever, walking the same
  // window on every tick and never reaching `complete`.
  it('does not mistake an account with no transactions for a dropped table', () => {
    const plan = historyWalkPlan({
      checkpoint: complete({txCount: 0, oldestEnumeratedHeight: 500, firstTxHeight: 500}),
      hasStoredRows: false,
      newestTxHeight: TOP,
      nowMs: NOW,
    })
    expect(plan.reason).not.toBe('no-stored-rows')
  })

  // The heart of it: an unfinished backfill continues *below* what it already enumerated, and the
  // upper bound is what makes it descend instead of re-reading the newest rows for ever.
  it('continues a backfill below what has been enumerated', () => {
    const plan = historyWalkPlan({
      checkpoint: complete({oldestEnumeratedHeight: 900_000, firstTxHeight: 100, complete: false}),
      hasStoredRows: true,
      newestTxHeight: TOP,
      nowMs: NOW,
    })
    expect(plan.reason).toBe('backfill')
    expect(plan.beforeBlock).toBe(900_000)
    expect(plan.afterBlock).toBe(900_000 - windowSpanFor(TOP - 900_000))
  })

  it("never walks below the account's oldest transaction", () => {
    const plan = historyWalkPlan({
      checkpoint: complete({oldestEnumeratedHeight: 1_000, firstTxHeight: 900, complete: false}),
      hasStoredRows: true,
      newestTxHeight: TOP,
      nowMs: NOW,
    })
    expect(plan.reason).toBe('backfill')
    expect(plan.afterBlock).toBe(900)
  })

  it('goes incremental from the height less the reorg margin once the backfill is done', () => {
    expect(historyWalkPlan({checkpoint: complete(), hasStoredRows: true, newestTxHeight: 10_000, nowMs: NOW})).toEqual({
      afterBlock: 10_000 - REORG_MARGIN_BLOCKS,
      beforeBlock: undefined,
      reason: 'incremental',
    })
  })

  it('never asks for a negative height', () => {
    const plan = historyWalkPlan({
      checkpoint: complete({newestBlockHeight: 3}),
      hasStoredRows: true,
      newestTxHeight: 3,
      nowMs: NOW,
    })
    expect(plan.afterBlock).toBe(0)
  })

  // ⚠️ Reconciliation re-reads Cardano's rollback bound, NOT the whole account. Re-walking everything
  // daily is what made a large account's sync unable to finish at all.
  it('reconciles the rollback window once the interval has passed', () => {
    const stale = complete({fullWalkAt: NOW - FULL_WALK_INTERVAL_MS - 1})
    expect(historyWalkPlan({checkpoint: stale, hasStoredRows: true, newestTxHeight: 10_000, nowMs: NOW})).toEqual({
      afterBlock: 10_000 - ROLLBACK_BOUND_BLOCKS,
      beforeBlock: undefined,
      reason: 'reconcile',
    })
  })

  it('treats a checkpoint that never reconciled as due', () => {
    // Built without the key rather than with `undefined`: `exactOptionalPropertyTypes` distinguishes
    // "absent" from "explicitly undefined", and absent is what an older checkpoint actually looks like.
    const noFull: HistoryReach = {newestBlockHeight: 10_000, complete: true, oldestEnumeratedHeight: 0}
    expect(historyWalkPlan({checkpoint: noFull, hasStoredRows: true, newestTxHeight: 10_000, nowMs: NOW}).reason).toBe(
      'reconcile',
    )
  })

  // ⚠️ Starting an incremental window at the height the *probe* reports would skip every transaction
  // between what we enumerated and what the account has done since. The anchor is ours, not the probe's.
  it('anchors an incremental window on the enumerated height, not the probe', () => {
    const plan = historyWalkPlan({
      checkpoint: complete({newestBlockHeight: 9_000}),
      hasStoredRows: true,
      newestTxHeight: 12_000,
      nowMs: NOW,
    })
    expect(plan.afterBlock).toBe(9_000 - REORG_MARGIN_BLOCKS)
  })

  // The probe is allowed to fail — that is the whole point of the rewrite — so every plan has to remain
  // expressible without it.
  it('still plans when the probe could not say how new the account is', () => {
    const plan = historyWalkPlan({
      checkpoint: complete({oldestEnumeratedHeight: 900_000, firstTxHeight: 100, complete: false}),
      hasStoredRows: true,
      newestTxHeight: undefined,
      nowMs: NOW,
    })
    expect(plan.reason).toBe('backfill')
    expect(plan.beforeBlock).toBe(900_000)
    expect(plan.afterBlock).toBeLessThan(900_000)
  })
})

describe('nextHistoryCheckpoint', () => {
  const base = {
    previous: complete({oldestEnumeratedHeight: 900_000, firstTxHeight: 100, complete: false}),
    newestTxHash: 'ab'.repeat(32),
    txCount: 42,
    firstTxHeight: undefined,
    wasReconcile: false,
    nowMs: NOW,
  }

  // ⚠️ The defect this whole change exists for: a walk whose probe timed out recorded nothing, so every
  // later run planned a first sync and re-walked history it could never finish.
  it('records the window even when the probe gave no hash', () => {
    const out = nextHistoryCheckpoint({
      ...base,
      newestTxHash: undefined,
      previousTxHash: 'cd'.repeat(32),
      maxBlockHeightSeen: 899_000,
      windowFloor: 800_000,
      persistedAll: true,
    })
    expect(out.oldestEnumeratedHeight).toBe(800_000)
    // ...and it must not erase the watermark the skip gate compares against.
    expect(out.txHash).toBe('cd'.repeat(32))
  })

  it('moves the floor down, never up', () => {
    const down = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 899_000,
      windowFloor: 800_000,
      persistedAll: true,
    })
    expect(down.oldestEnumeratedHeight).toBe(800_000)
    // A window at the recent end has a much higher floor; it must not undo the backfill's progress.
    const up = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 999_000,
      windowFloor: 990_000,
      persistedAll: true,
    })
    expect(up.oldestEnumeratedHeight).toBe(900_000)
  })

  // Claiming to have enumerated a window whose rows were not written leaves a hole nothing returns for.
  it('does not lower the floor when a page failed to persist', () => {
    const out = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 899_000,
      windowFloor: 800_000,
      persistedAll: false,
    })
    expect(out.oldestEnumeratedHeight).toBe(900_000)
    expect(out.complete).toBe(false)
  })

  it('a window with no lower bound has reached the beginning of history', () => {
    const out = nextHistoryCheckpoint({
      ...base,
      previous: null,
      maxBlockHeightSeen: 500,
      windowFloor: undefined,
      persistedAll: true,
    })
    expect(out.oldestEnumeratedHeight).toBe(0)
    expect(out.complete).toBe(true)
  })

  // An incremental window legitimately sees nothing when its trigger was a transaction already stored.
  it('never moves the height backwards', () => {
    const out = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: undefined,
      windowFloor: 800_000,
      persistedAll: true,
    })
    expect(out.newestBlockHeight).toBe(10_000)
    const older = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 9_000,
      windowFloor: 800_000,
      persistedAll: true,
    })
    expect(older.newestBlockHeight).toBe(10_000)
  })

  it('carries the account floor forward once it is known', () => {
    const out = nextHistoryCheckpoint({
      ...base,
      previous: {oldestEnumeratedHeight: 900_000},
      firstTxHeight: 7_205_959,
      maxBlockHeightSeen: undefined,
      windowFloor: 800_000,
      persistedAll: true,
    })
    expect(out.firstTxHeight).toBe(7_205_959)
  })

  it('stamps the reconcile time for a reconcile pass, and when a backfill first finishes', () => {
    const reconciled = nextHistoryCheckpoint({
      ...base,
      previous: complete(),
      wasReconcile: true,
      maxBlockHeightSeen: 10_050,
      windowFloor: 9_000,
      persistedAll: true,
    })
    expect(reconciled.fullWalkAt).toBe(NOW)
    // A backfill that has just reached the bottom must not be immediately due for reconciliation.
    const justFinished = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 200,
      windowFloor: 50,
      persistedAll: true,
    })
    expect(justFinished.complete).toBe(true)
    expect(justFinished.fullWalkAt).toBe(NOW)
    // An ordinary incremental window changes nothing about it.
    const incremental = nextHistoryCheckpoint({
      ...base,
      previous: complete(),
      maxBlockHeightSeen: 10_050,
      windowFloor: 9_990,
      persistedAll: true,
    })
    expect(incremental.fullWalkAt).toBe(complete().fullWalkAt)
  })

  // The round trip that matters: each window's checkpoint must license the next window to go lower.
  it('produces a checkpoint the plan continues from', () => {
    const written = nextHistoryCheckpoint({
      ...base,
      maxBlockHeightSeen: 899_000,
      windowFloor: 800_000,
      persistedAll: true,
    })
    const next = historyWalkPlan({
      checkpoint: written,
      hasStoredRows: true,
      newestTxHeight: 1_000_000,
      nowMs: NOW + 1000,
    })
    expect(next.reason).toBe('backfill')
    expect(next.beforeBlock).toBe(800_000)
    expect(next.afterBlock).toBeLessThan(800_000)
  })

  // Two runs in a row must not walk the same window — the regression that made the whale never advance.
  it('advances across successive runs rather than repeating a window', () => {
    let reach: HistoryReach | null = null
    const floors: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const plan = historyWalkPlan({checkpoint: reach, hasStoredRows: true, newestTxHeight: 1_000_000, nowMs: NOW})
      reach = nextHistoryCheckpoint({
        previous: reach,
        newestTxHash: undefined,
        maxBlockHeightSeen: undefined,
        windowFloor: plan.afterBlock,
        firstTxHeight: 100,
        persistedAll: true,
        wasReconcile: false,
        txCount: 0,
        nowMs: NOW,
      })
      floors.push(reach.oldestEnumeratedHeight ?? -1)
    }
    expect(new Set(floors).size).toBe(floors.length)
    expect(floors).toEqual([...floors].sort((a, b) => b - a))
  })
})

describe('shouldProbeHistoryFloor', () => {
  const base = {knownFirstTxHeight: undefined, hasRewardAddress: true, hasAccountTxs: true}

  it('probes for a wallet that has an account but no known floor', () => {
    expect(shouldProbeHistoryFloor(base)).toBe(true)
  })

  it('probes for a shared wallet, whose rail is never a whole-account watch', () => {
    // The regression. A CIP-1854 shared wallet's rail leaves `accountUtxoMode` unset, and
    // the probe used to be gated on that being `'all'`. So a wallet minutes old, holding
    // one transaction, backfilled toward genesis — on mainnet, ~13.9M blocks of it.
    // Nothing about a shared wallet is special here: it has a (script) reward address, so
    // it can be asked, and the answer bounds its history exactly as for any other wallet.
    expect(shouldProbeHistoryFloor({...base, hasRewardAddress: true, hasAccountTxs: true})).toBe(true)
  })

  it('does not re-ask once the floor is known — it is a fact about history', () => {
    expect(shouldProbeHistoryFloor({...base, knownFirstTxHeight: 12_345})).toBe(false)
  })

  it('treats a known floor of 0 as known, not as absent', () => {
    expect(shouldProbeHistoryFloor({...base, knownFirstTxHeight: 0})).toBe(false)
  })

  it('cannot ask when there is no account to ask about', () => {
    expect(shouldProbeHistoryFloor({...base, hasRewardAddress: false})).toBe(false)
  })

  it('cannot ask a provider that does not implement the stake-keyed listing', () => {
    expect(shouldProbeHistoryFloor({...base, hasAccountTxs: false})).toBe(false)
  })
})
