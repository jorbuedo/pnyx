// The ordering of `syncCardanoHistory`'s walk, which is the difference between a list that fills in a
// second and one that fills in minutes. Everything else here is mapping, covered elsewhere.

import {type Provider as EvolutionProvider, TransactionHash} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {cardanoDataRef, clearCardanoDataStore, setCardanoDataStore} from './cardano-store'
import {syncCardanoHistory} from './history'
import type {CardanoRail} from './rail'
import {REORG_MARGIN_BLOCKS} from './sync-decision'

// ⚠️ A REAL bech32: the walk decodes addresses now, so a placeholder would fail to parse rather
// than being carried through. The old `'addr_test1qown'` survived only because every stub below
// is cast with `as unknown as CardanoRail`, which is also why none of this failed to compile.
const ADDR = 'addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw'
const REWARD = 'stake_test1up4dh5etpe4g55cgsg4uhlfm0hrhzn35287ur57aksgqjwce84m7h'
const dataRef = cardanoDataRef('group-1', 'cardano:preprod', 0)

/** A page of `n` refs whose hashes are unique per page. */
const refPage = (page: number, n: number): EvolutionProvider.IndexedTxRef[] =>
  Array.from({length: n}, (_, i) => ({
    txHash: TransactionHash.fromHex(`${page}`.padStart(2, '0') + `${i}`.padStart(62, '0')),
    blockHeight: 1_000 - page * 100 - i,
    blockTime: 1,
    epochNo: 1,
  }))

/**
 * Minimal tx detail, in the shape the typed client returns.
 *
 * ⚠️ `fee` is a `bigint`. It was the string `'1000'` here, which no provider has ever returned —
 * the cast on the rail stub is what let a wrong fixture stand in for a real one.
 */
const txInfoFor = (hash: TransactionHash.TransactionHash): EvolutionProvider.IndexedTx => ({
  txHash: hash,
  blockHeight: 1,
  blockTime: 1,
  fee: 1000n,
  inputs: [],
  outputs: [],
  certificates: [],
  withdrawals: [],
  mint: [],
})

type Call = {readonly kind: 'txsAt' | 'txInfo' | 'save'; readonly count: number}

const harness = (pages: number) => {
  const calls: Call[] = []
  const saved: string[] = []
  let pageIndex = 0

  const store = {
    listTxRows: () => Effect.succeed([]),
    saveTxRows: (rows: readonly {readonly hash: string}[]) =>
      Effect.sync(() => {
        calls.push({kind: 'save', count: rows.length})
        saved.push(...rows.map((r) => r.hash))
      }),
    loadTxCheckpoint: () => Effect.succeed(null),
    saveTxCheckpoint: () => Effect.void,
  }
  setCardanoDataStore(store as never)

  const rail = {
    dataRef,
    knownAddresses: [ADDR],
    rewardAddressBech32: null,
    config: {networkId: 0, network: 'preprod'},
    chain: {
      // Required on the real client; the walk anchors its first window on it when the
      // account-level probe cannot answer.
      getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
      getTxsAt: (_addrs: readonly unknown[], _opts?: unknown) =>
        Effect.sync(() => {
          const page = pageIndex < pages ? refPage(pageIndex, 1000) : []
          pageIndex += 1
          calls.push({kind: 'txsAt', count: page.length})
          return page
        }),
      getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) =>
        Effect.sync(() => {
          calls.push({kind: 'txInfo', count: hashes.length})
          return hashes.map(txInfoFor)
        }),
    },
  } as unknown as CardanoRail

  return {rail, calls, saved}
}

describe('syncCardanoHistory', () => {
  beforeEach(() => clearCardanoDataStore())
  afterEach(() => clearCardanoDataStore())

  // ⚠️ The defect this exists for. The walk used to collect every reference for every address batch
  // before fetching or persisting a single detail, so the store stayed empty until the entire history
  // was enumerated — and the home widget, which shows three rows, sat on skeletons for minutes on a
  // wallet with thousands of transactions. The pages arrive newest-first, so page one already holds
  // what every surface shows first.
  // ⚠️ The caller's cue to resume. A run stops on the walker's time budget with its progress
  // recorded, and nothing continued it — history advanced a few windows per rail change or
  // manual refresh, so a mainnet import whose first transaction sat 6.2M blocks under the tip
  // filled a slice at a time and only when the user poked the screen. The outcome has to
  // distinguish "finished" from "stopped early", or the caller cannot know to come back.
  it('reports a completed walk as not paused, so the caller stops', async () => {
    const {rail} = harness(3)
    const outcome = await Effect.runPromise(syncCardanoHistory(rail))

    expect(outcome.backfillPaused).toBe(false)
  })

  /**
   * ⚠️ **The count is what earns a caller the right to spend the rail's sync throttle.** A wallet
   * whose list just gained a transaction has a balance built before it — which is how a received
   * payment showed as "+5 ADA" above a wallet still reading 0 ADA. Zero on a walk that stored
   * nothing, because "we did not look" must not read as "we looked and nothing was there".
   */
  it('reports how many transactions it stored that it had never seen', async () => {
    const {rail} = harness(3)
    // Three pages of a thousand, all of them new to this wallet.
    const first = await Effect.runPromise(syncCardanoHistory(rail))
    expect(first.storedNew).toBe(3_000)

    // Walked again immediately, the run reports nothing new — whichever way it short-circuits
    // (`canSkipHistoryWalk`, or every hash already known), a caller must not be handed a reason to
    // spend the rail's throttle on a wallet that did not move.
    const second = await Effect.runPromise(syncCardanoHistory(rail))
    expect(second.storedNew).toBe(0)
  })

  it('reports not paused when a concurrent walk already owns the wallet', async () => {
    const {rail} = harness(3)
    const [first, second] = await Effect.runPromise(
      Effect.all([syncCardanoHistory(rail), syncCardanoHistory(rail)], {concurrency: 2}),
    )

    // Whichever tick deferred must not also ask to resume, or two loops fight over one wallet.
    expect([first?.backfillPaused, second?.backfillPaused]).toEqual([false, false])
  })

  it('persists the first page before asking for the second', async () => {
    const {rail, calls} = harness(3)
    await Effect.runPromise(syncCardanoHistory(rail))

    const firstSave = calls.findIndex((c) => c.kind === 'save')
    const secondPage = calls
      .map((c) => c.kind)
      .reduce<number[]>((at, kind, i) => (kind === 'txsAt' ? [...at, i] : at), [])[1]
    expect(firstSave).toBeGreaterThan(-1)
    expect(secondPage).toBeGreaterThan(-1)
    expect(firstSave).toBeLessThan(secondPage as number)
  })

  // ⚠️ A watch of a whole stake account cannot enumerate its addresses — 490,000 for the one that
  // prompted this, answered as 51 MB. So its history comes from the stake-keyed endpoint, which returns
  // transactions on addresses that hold nothing today and would be absent from any list we could fetch.
  it('walks the stake-keyed endpoint when the account is the wallet', async () => {
    const asked: string[] = []
    let pageIndex = 0
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (stake: string, opts?: {readonly limit?: number}) =>
          Effect.sync(() => {
            // The `limit: 1` newest-tx probe runs first; only the paged walk counts here.
            if (opts?.limit === 1) return []
            asked.push(`accountTxs:${String(stake)}`)
            const page = pageIndex === 0 ? refPage(0, 5) : []
            pageIndex += 1
            return page
          }),
        getTxsAt: (addrs: readonly unknown[]) =>
          Effect.sync(() => {
            asked.push(`txsAt:${addrs.length}`)
            return []
          }),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    expect(asked.some((a) => a.startsWith('accountTxs:'))).toBe(true)
    // The address fanout must not run: that is the 490,000-address path.
    expect(asked.some((a) => a.startsWith('txsAt:'))).toBe(false)
  })

  // The ordinary wallet keeps the address fanout and exact-set ownership, because an address that
  // merely shares our public stake credential is not ours — the rail's `'owned'` mode exists for that.
  it('keeps the address fanout when the account is not the wallet', async () => {
    const {rail, calls} = harness(1)
    await Effect.runPromise(syncCardanoHistory(rail))
    expect(calls.some((c) => c.kind === 'txsAt')).toBe(true)
  })

  // ⚠️ The pure plan passing proves nothing about the walk. This is the behaviour Jordi saw: a wallet
  // that receives a transaction every few minutes re-enumerated its entire history each time, because
  // the walk paged from offset 0 to exhaustion and never passed `afterBlock` — even though both the
  // cursor helper and the provider option already existed.
  it('asks only for blocks above the checkpoint when the previous walk completed', async () => {
    const asked: (number | undefined)[] = []
    const fanout: string[] = []
    setCardanoDataStore({
      // A stored row exists, so the plan is not forced into a full walk.
      listTxRows: () => Effect.succeed([{hash: 'ff'.repeat(32)}]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () =>
        Effect.succeed({
          blockHash: '',
          txHash: 'ff'.repeat(32),
          txCount: 1,
          newestBlockHeight: 9_000,
          complete: true,
          fullWalkAt: Date.now() - 1000,
        }),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number; readonly afterBlock?: number}) =>
          Effect.sync(() => {
            // The tip probe asks for one row and must not be counted as part of the walk.
            if (opts?.limit === 1) return refPage(0, 1)
            asked.push(opts?.afterBlock)
            return []
          }),
        // ⚠️ Present only because `syncCardanoHistory` refuses to run without it, even here where the
        // whole-account path means it is never called. Recorded so the assertion can prove that.
        getTxsAt: () => Effect.sync(() => fanout.push('txsAt') && []),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    expect(fanout).toEqual([])
    expect(asked.length).toBeGreaterThan(0)
    // 9_000 minus the reorg margin — the height we enumerated, not the account's newest tx, and not a
    // re-enumeration of everything.
    for (const afterBlock of asked) expect(afterBlock).toBe(9_000 - REORG_MARGIN_BLOCKS)
  })

  // An interrupted walk restarts at the newest window rather than re-enumerating the whole account in
  // one request: unbounded enumeration is exactly what a large account cannot finish. It re-descends
  // from the top, and each window it completes is recorded on the way.
  it('restarts at the newest window when the previous walk did not complete', async () => {
    const asked: (number | undefined)[] = []
    const fanout: string[] = []
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([{hash: 'ff'.repeat(32)}]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () =>
        Effect.succeed({blockHash: '', txHash: 'ff'.repeat(32), txCount: 1, newestBlockHeight: 9_000, complete: false}),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number; readonly afterBlock?: number}) =>
          Effect.sync(() => {
            if (opts?.limit === 1) return refPage(0, 1)
            asked.push(opts?.afterBlock)
            return []
          }),
        // ⚠️ Present only because `syncCardanoHistory` refuses to run without it, even here where the
        // whole-account path means it is never called. Recorded so the assertion can prove that.
        getTxsAt: () => Effect.sync(() => fanout.push('txsAt') && []),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    expect(fanout).toEqual([])
    expect(asked.length).toBeGreaterThan(0)
    // Bounded, and never the whole account at once.
    for (const afterBlock of asked) expect(afterBlock).not.toBeUndefined()
  })

  // The claim a checkpoint makes has to be earned by the run that writes it.
  it('records the reach and the completion the walk actually achieved', async () => {
    const saved: unknown[] = []
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: (_ref: unknown, checkpoint: unknown) => Effect.sync(() => saved.push(checkpoint)),
    } as never)
    let page = 0
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number}) =>
          Effect.sync(() => {
            if (opts?.limit === 1) return refPage(0, 1)
            // One short page: the walk exhausts immediately.
            page += 1
            return page === 1 ? refPage(0, 3) : []
          }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({complete: true})
    expect((saved[0] as {newestBlockHeight?: number}).newestBlockHeight).toBeGreaterThan(0)
    expect((saved[0] as {fullWalkAt?: number}).fullWalkAt).toBeGreaterThan(0)
  })

  // ⚠️ The most dangerous branch, and the one a mutation proved was uncovered. A page whose write fails
  // is logged and the walk continues — correct, it should not abort — but if the checkpoint then claimed
  // `complete`, the next run would go incremental over a store that is missing that page, and nothing
  // would ever go back for it.
  it('refuses to claim complete when a page fails to persist', async () => {
    const saved: {complete?: boolean}[] = []
    let page = 0
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: () => Effect.fail(new Error('disk full')),
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: (_ref: unknown, checkpoint: {complete?: boolean}) =>
        Effect.sync(() => {
          saved.push(checkpoint)
        }),
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number}) =>
          Effect.sync(() => {
            if (opts?.limit === 1) return refPage(0, 1)
            page += 1
            return page === 1 ? refPage(0, 3) : []
          }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    // Written per window now, so the count is not the assertion — that none of them claims completeness
    // is. A failed persist must never license the next run to skip what is missing.
    expect(saved.length).toBeGreaterThan(0)
    for (const checkpoint of saved) expect(checkpoint?.complete).toBe(false)
  })

  it('fetches every transaction exactly once across pages', async () => {
    const {rail, saved} = harness(3)
    await Effect.runPromise(syncCardanoHistory(rail))
    expect(saved).toHaveLength(3_000)
    expect(new Set(saved).size).toBe(3_000)
  })

  // A transaction touching several of our addresses appears on more than one page; `seen` carries
  // across pages so its detail is fetched once, not once per appearance.
  it('does not re-fetch a hash it has already seen on an earlier page', async () => {
    const calls: Call[] = []
    let pageIndex = 0
    const repeated = refPage(0, 10)
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: (rows: readonly unknown[]) => Effect.sync(() => calls.push({kind: 'save', count: rows.length})),
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: null,
      config: {networkId: 0, network: 'preprod'},
      chain: {
        // Required on the real client; the walk anchors its first window on it when the
        // account-level probe cannot answer.
        getTip: () => Effect.succeed({slot: 0, blockHeight: 1_000}),
        // The same ten refs twice, then done.
        getTxsAt: () =>
          Effect.sync(() => {
            const page = pageIndex < 2 ? repeated : []
            pageIndex += 1
            return page
          }),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) =>
          Effect.sync(() => {
            calls.push({kind: 'txInfo', count: hashes.length})
            return hashes.map(txInfoFor)
          }),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    const fetchedTotal = calls.filter((c) => c.kind === 'txInfo').reduce((n, c) => n + c.count, 0)
    expect(fetchedTotal).toBe(10)
  })
})

describe('syncCardanoHistory concurrency', () => {
  // ⚠️ Sync ticks overlap. Observed on a large account: a second run read the checkpoint before the
  // first had written it and planned the identical window — so both walked the same range, and neither
  // saw the other's progress. Deep windows take tens of seconds, so the overlap is the normal case.
  it('defers a second walk for the same wallet instead of duplicating it', async () => {
    let walks = 0
    let release: (() => void) | undefined
    const firstPageStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        tip: Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number}) =>
          opts?.limit === 1
            ? Effect.succeed(refPage(0, 1))
            : Effect.promise(async () => {
                walks += 1
                release?.()
                // Hold the first walk open so the second one arrives while it is still running.
                await new Promise((r) => setTimeout(r, 20))
                return []
              }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    const first = Effect.runPromise(syncCardanoHistory(rail))
    await firstPageStarted
    await Effect.runPromise(syncCardanoHistory(rail))
    await first

    expect(walks).toBe(1)
  })

  // The guard must not leak: a wallet whose walk finished has to be walkable again.
  it('releases the wallet once its walk finishes', async () => {
    let walks = 0
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([]),
      saveTxRows: () => Effect.void,
      loadTxCheckpoint: () => Effect.succeed(null),
      saveTxCheckpoint: () => Effect.void,
    } as never)
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        tip: Effect.succeed({slot: 0, blockHeight: 1_000}),
        getAccountTxs: (_s: string, opts?: {readonly limit?: number}) =>
          opts?.limit === 1
            ? Effect.succeed(refPage(0, 1))
            : Effect.sync(() => {
                walks += 1
                return []
              }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))
    await Effect.runPromise(syncCardanoHistory(rail))

    expect(walks).toBeGreaterThan(1)
  })
})

describe('syncCardanoHistory descent within one run', () => {
  beforeEach(() => clearCardanoDataStore())
  afterEach(() => clearCardanoDataStore())

  // ⚠️ `hasStoredRows` used to be one read taken before the window loop, and every window was planned
  // against it. So a first sync's second window still saw an empty table while the checkpoint it had
  // just written carried `txCount > 0` — the `no-stored-rows` case — and re-planned the *newest*
  // window instead of descending. The run then spent its whole budget on the window it had finished.
  // A descending window is bounded above; the newest window is not, which is the difference asserted.
  it('descends after the first window instead of re-planning the newest one', async () => {
    const windows: {readonly afterBlock: number | undefined; readonly beforeBlock: number | undefined}[] = []
    const rows: {readonly hash: string}[] = []
    let checkpoint: unknown = null
    let pagesServed = 0

    setCardanoDataStore({
      listTxRows: () => Effect.succeed([...rows]),
      saveTxRows: (saved: readonly {readonly hash: string}[]) =>
        Effect.sync(() => {
          rows.push(...saved)
        }),
      loadTxCheckpoint: () => Effect.succeed(checkpoint),
      saveTxCheckpoint: (_ref: unknown, next: unknown) =>
        Effect.sync(() => {
          checkpoint = next
        }),
    } as never)

    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        tip: Effect.succeed({slot: 0, blockHeight: 1_000_000}),
        getAccountTxs: (
          _s: string,
          opts?: {
            readonly limit?: number
            readonly order?: string
            readonly afterBlock?: number
            readonly beforeBlock?: number
          },
        ) =>
          Effect.sync(() => {
            // The account's oldest transaction, well below the first window's floor so the backfill
            // has somewhere left to descend to.
            if (opts?.order === 'asc')
              return [{txHash: TransactionHash.fromHex('a'.repeat(64)), blockHeight: 1, blockTime: 1, epochNo: 1}]
            // The newest-tx probe.
            if (opts?.limit === 1)
              return [
                {txHash: TransactionHash.fromHex('b'.repeat(64)), blockHeight: 1_000_000, blockTime: 1, epochNo: 1},
              ]
            windows.push({afterBlock: opts?.afterBlock, beforeBlock: opts?.beforeBlock})
            // One page of real rows in the first window, nothing after — so the only thing that can
            // move the second window's plan is what the first window persisted.
            pagesServed += 1
            return pagesServed === 1
              ? [{txHash: TransactionHash.fromHex('c'.repeat(64)), blockHeight: 960_000, blockTime: 1, epochNo: 1}]
              : []
          }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail

    await Effect.runPromise(syncCardanoHistory(rail))

    expect(rows.length).toBeGreaterThan(0)
    expect(windows.length).toBeGreaterThan(1)
    // The first window is the newest one — unbounded above, by design.
    expect(windows[0]?.beforeBlock).toBeUndefined()
    // The second must be a backfill window: bounded above by what the first enumerated, and starting
    // strictly below it.
    expect(windows[1]?.beforeBlock).toBe(950_000)
    expect(windows[1]?.afterBlock).toBeLessThan(950_000)
  })
})

describe('syncCardanoHistory window budget', () => {
  beforeEach(() => clearCardanoDataStore())
  afterEach(() => clearCardanoDataStore())

  /** Counts the windows a run walks, by counting the real (non-probe) page requests it opens. */
  const countingRail = () => {
    const windows: {readonly afterBlock: number | undefined; readonly beforeBlock: number | undefined}[] = []
    const rows: {readonly hash: string}[] = []
    let checkpoint: unknown = null
    setCardanoDataStore({
      listTxRows: () => Effect.succeed([...rows]),
      saveTxRows: (saved: readonly {readonly hash: string}[]) =>
        Effect.sync(() => {
          rows.push(...saved)
        }),
      loadTxCheckpoint: () => Effect.succeed(checkpoint),
      saveTxCheckpoint: (_ref: unknown, next: unknown) =>
        Effect.sync(() => {
          checkpoint = next
        }),
    } as never)
    let served = 0
    const rail = {
      dataRef,
      knownAddresses: [ADDR],
      rewardAddressBech32: REWARD,
      accountUtxoMode: 'all',
      config: {networkId: 0, network: 'preprod'},
      codec: {addressFromBech32: () => ({})},
      chain: {
        tip: Effect.succeed({slot: 0, blockHeight: 1_000_000}),
        getAccountTxs: (
          _s: string,
          opts?: {
            readonly limit?: number
            readonly order?: string
            readonly offset?: number
            readonly afterBlock?: number
            readonly beforeBlock?: number
          },
        ) =>
          Effect.sync(() => {
            // Oldest tx at height 1, so the backfill always has somewhere left to descend to and
            // the run is bounded by the budget rather than by reaching the floor.
            if (opts?.order === 'asc')
              return [{txHash: TransactionHash.fromHex('a'.repeat(64)), blockHeight: 1, blockTime: 1, epochNo: 1}]
            if (opts?.limit === 1)
              return [
                {txHash: TransactionHash.fromHex('b'.repeat(64)), blockHeight: 1_000_000, blockTime: 1, epochNo: 1},
              ]
            if (opts?.offset === 0) windows.push({afterBlock: opts?.afterBlock, beforeBlock: opts?.beforeBlock})
            served += 1
            return served === 1
              ? [{txHash: TransactionHash.fromHex('c'.repeat(64)), blockHeight: 960_000, blockTime: 1, epochNo: 1}]
              : []
          }),
        getTxsAt: () => Effect.succeed([]),
        getTxInfo: (hashes: readonly TransactionHash.TransactionHash[]) => Effect.sync(() => hashes.map(txInfoFor)),
      },
    } as unknown as CardanoRail
    return {rail, windows}
  }

  // ⚠️ Why this exists: the wallet-home widget shows three rows, and its pull-to-refresh ran the
  // full walk — up to 64 windows, the deep ones measured at tens of seconds each — to refresh them.
  it('walks exactly one window when the caller asks for one', async () => {
    const {rail, windows} = countingRail()
    await Effect.runPromise(syncCardanoHistory(rail, {maxWindows: 1}))
    expect(windows).toHaveLength(1)
  })

  it('walks more than one when it may, so the backfill still descends', async () => {
    const {rail, windows} = countingRail()
    await Effect.runPromise(syncCardanoHistory(rail, {maxWindows: 4}))
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.length).toBeLessThanOrEqual(4)
  })

  // A budget of zero would be a run that walks nothing and records nothing — silently no-op sync.
  it('never walks zero windows, whatever it is asked for', async () => {
    const {rail, windows} = countingRail()
    await Effect.runPromise(syncCardanoHistory(rail, {maxWindows: 0}))
    expect(windows).toHaveLength(1)
  })
})
