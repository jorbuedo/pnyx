import {Effect, SubscriptionRef} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import type {SocketEvents, SocketFactory} from './graphql-ws'

/**
 * A real listener set, but countable. The leak this pins is unbounded *growth* — the projection stays
 * correct either way, because listeners fire in insertion order and the live one runs last.
 */
const lockListenerCount = () => listeners.size
const listeners = new Set<() => void>()
vi.mock('../../store-change', () => ({
  onStoreChange: (_topic: string, listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  notifyStoreChange: vi.fn(),
  publishStoreChange: () => Effect.void,
}))

vi.mock('../../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))
vi.mock('../contract-state', () => ({
  midnightIndexerUrlFor: (network: string | null) =>
    network === 'nosuchnet' ? null : `https://indexer.${String(network)}/api/v4/graphql`,
}))

const saved: {groupId: string; accountIndex: number; cache: unknown}[] = []
let stored: unknown

vi.mock('./unshielded-store', () => ({
  // ⚠️ Async on purpose. The real one is `Effect.tryPromise` over MMKV, so it yields — and the
  // concurrent-start race only exists across that yield. A synchronous `Effect.succeed` mock made the
  // race untestable and the guard's mutation test pass with the guard removed.
  loadUnshieldedCache: () => Effect.promise(async () => stored),
  saveUnshieldedCache: (groupId: string, accountIndex: number, cache: unknown) =>
    Effect.sync(() => {
      saved.push({groupId, accountIndex, cache})
    }),
}))

const {
  awaitFeedCaughtUp,
  feedKey,
  FEED_SILENCE_LIMIT_MS,
  feedOwns,
  feedReaders,
  feedRegistered,
  reconnectDelayMs,
  startUnshieldedFeed,
  stopAllUnshieldedFeeds,
  stopUnshieldedFeed,
  unshieldedLive,
} = await import('./unshielded-live')

const {logger} = await import('../../../logger')
const {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} = await import('./unshielded')

const ADDRESS = 'mn_addr_preprod1ours'
const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000'
const GROUP = 'group-a'

const utxo = (over: Record<string, unknown> = {}) => ({
  owner: ADDRESS,
  tokenType: NIGHT,
  value: '1000000',
  intentHash: 'aa11',
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

const progress = (highestTransactionId: number) => ({
  type: 'next',
  id: '1',
  payload: {data: {unshieldedTransactions: {__typename: 'UnshieldedTransactionsProgress', highestTransactionId}}},
})

const tx = (id: number, created: readonly unknown[] = []) => ({
  type: 'next',
  id: '1',
  payload: {
    data: {
      unshieldedTransactions: {
        __typename: 'UnshieldedTransaction',
        transaction: {id, hash: `hash${id}`},
        createdUtxos: created,
        spentUtxos: [],
      },
    },
  },
})

const scripted = (frames: readonly unknown[], framesPerOpen?: readonly (readonly unknown[])[]) => {
  let deliver: ((frame: unknown) => void) | undefined
  /** Fires the socket's own `onError`, which is the only path that produces a stack-carrying failure. */
  let breakSocket: (() => void) | undefined
  let closes = 0
  let opens = 0
  /** The resume cursor each `subscribe` asked for — what a reconnect's correctness turns on. */
  const cursors: number[] = []
  const factory: SocketFactory = (_url, _protocol, events: SocketEvents) => {
    const opening = opens
    opens += 1
    deliver = (frame: unknown) => events.onMessage(JSON.stringify(frame))
    breakSocket = () => events.onError(new Error('the transport went away'))
    setTimeout(() => events.onOpen(), 0)
    return {
      send: (data) => {
        const parsed = JSON.parse(data) as {
          type?: string
          payload?: {variables?: {transactionId?: number}}
        }
        if (parsed.type === 'connection_init') setTimeout(() => deliver?.({type: 'connection_ack'}), 0)
        if (parsed.type === 'subscribe') {
          cursors.push(parsed.payload?.variables?.transactionId ?? -1)
          // A script per open, when a test needs the second socket to say something different from
          // the first; otherwise every open replays the same frames.
          const forThisOpen = framesPerOpen?.[opening] ?? frames
          setTimeout(() => forThisOpen.forEach((f) => deliver?.(f)), 0)
        }
      },
      close: () => {
        closes += 1
      },
    }
  }
  return {
    factory,
    push: (frame: unknown) => deliver?.(frame),
    fail: () => breakSocket?.(),
    closed: () => closes,
    opened: () => opens,
    cursors: () => [...cursors],
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))

/**
 * Long enough for the first reconnect backoff to elapse and the next socket to be opened.
 *
 * Real time, not a fake clock: the loop sleeps on Effect's clock, which `vi.useFakeTimers` does not
 * reach. One second is the first delay by design — see `reconnectDelayMs`.
 */
const afterBackoff = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1_300))

const liveFor = async (key: string) => (await Effect.runPromise(SubscriptionRef.get(unshieldedLive))).get(key)

beforeEach(async () => {
  await Effect.runPromise(stopAllUnshieldedFeeds())
  listeners.clear()
  saved.length = 0
  stored = undefined
  vi.clearAllMocks()
})

describe('startUnshieldedFeed', () => {
  it('publishes what the replay says, and reports catch-up', async () => {
    const {factory} = scripted([progress(2), tx(1, [utxo()]), tx(2, [utxo({outputIndex: 1})])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    const live = await liveFor(feedKey(GROUP, 0, 'preprod'))
    expect(live?.utxos.size).toBe(2)
    expect(live?.caughtUp).toBe(true)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('keeps the feed open and publishes what arrives after catch-up', async () => {
    // The whole reason this module exists: the one-shot closes the socket here, which is why every
    // surface then had to be told to re-read.
    const {factory, push} = scripted([progress(1), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect((await liveFor(feedKey(GROUP, 0, 'preprod')))?.utxos.size).toBe(1)
    push(tx(2, [utxo({intentHash: 'bb22'})]))
    await settle()
    expect((await liveFor(feedKey(GROUP, 0, 'preprod')))?.utxos.size).toBe(2)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('writes the cache once for the whole replay, not once per transaction', async () => {
    // A first replay is dozens of transactions and the blob grows with each; writing per frame would
    // be dozens of serialisations of the same growing value.
    const frames = [progress(5), ...[1, 2, 3, 4, 5].map((n) => tx(n, [utxo({intentHash: `h${n}`})]))]
    const {factory} = scripted(frames)
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect(saved.length).toBe(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('writes again for each transaction that lands after catch-up', async () => {
    const {factory, push} = scripted([progress(1), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect(saved.length).toBe(1)
    push(tx(2, [utxo({intentHash: 'bb22'})]))
    await settle()
    expect(saved.length).toBe(2)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('refuses a network this build has no indexer for, rather than opening nothing quietly', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(startUnshieldedFeed({groupId: GROUP, accountIndex: 0, address: ADDRESS, network: 'nosuchnet'})),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.cause).toBe('not-configured')
  })

  it('starts one feed per key, not one per call', async () => {
    const {factory} = scripted([progress(0)])
    const start = () =>
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      })
    await Effect.runPromise(start())
    await Effect.runPromise(start())
    await settle()
    expect(feedOwns(feedKey(GROUP, 0, 'preprod'))).toBe(true)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})

describe('the key carries the network', () => {
  it('a switch finds nothing rather than the other chain figures', async () => {
    // `state-store.ts` records a network switch having actually handed back the other chain's coins,
    // and a switch does not reload the process. A network-free key would reintroduce that here.
    const {factory} = scripted([progress(1), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect(await liveFor(feedKey(GROUP, 0, 'preprod'))).toBeDefined()
    expect(await liveFor(feedKey(GROUP, 0, 'mainnet'))).toBeUndefined()
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})

describe('the resume base', () => {
  it('ignores a cache belonging to another address', async () => {
    // Not a resume base — another wallet's history. Folding onto it would report their coins as ours.
    stored = {
      utxos: new Map([['zz:0', utxo({intentHash: 'zz'})]]),
      activity: [],
      transactionId: 40,
      address: 'someone-else',
    }
    const {factory} = scripted([progress(1), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect((await liveFor(feedKey(GROUP, 0, 'preprod')))?.utxos.size).toBe(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})

describe('stopping', () => {
  it('interrupts the feed, closes the socket, and drops the projection', async () => {
    const {factory, closed} = scripted([progress(0)])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    await Effect.runPromise(stopUnshieldedFeed(key))
    await settle()
    expect(feedOwns(key)).toBe(false)
    expect(await liveFor(key)).toBeUndefined()
    expect(closed()).toBeGreaterThan(0)
  })

  it('stopAll leaves nothing running and nothing published — what a lock or a wipe needs', async () => {
    // `profile-wipe.ts` deletes the underlying keys without going through the cache modules, so
    // anything holding a parsed copy has to be told separately or it survives the wipe.
    const a = scripted([progress(0)])
    const b = scripted([progress(0)])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: a.factory,
      }),
    )
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 1,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: b.factory,
      }),
    )
    await settle()
    await Effect.runPromise(stopAllUnshieldedFeeds())
    await settle()
    expect(feedOwns(feedKey(GROUP, 0, 'preprod'))).toBe(false)
    expect(feedOwns(feedKey(GROUP, 1, 'preprod'))).toBe(false)
    expect((await Effect.runPromise(SubscriptionRef.get(unshieldedLive))).size).toBe(0)
  })
})

describe('a caller deadline on the feed path', () => {
  it('syncUnshieldedWallet gives up on the timeout it was passed', async () => {
    // ⚠️ Through the real entry point, not `awaitFeedCaughtUp` directly — the primitive always honoured
    // its argument; what was broken was the *threading*. `timeoutMs` reached only the one-shot socket, so
    // a money path asking not to be kept waiting was obeyed on one path and ignored on this one, then
    // answered `not-ready` anyway after the full default.
    const {factory} = scripted([progress(9), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    // The indexer named 9 and sent one transaction, so the replay is genuinely unfinished.
    expect((await liveFor(feedKey(GROUP, 0, 'preprod')))?.caughtUp).toBe(false)
    const startedAt = performance.now()
    const outcome = await Effect.runPromise(
      syncUnshieldedWallet({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        timeoutMs: 120,
      }),
    )
    const waited = performance.now() - startedAt
    // Answered from the cache, and flagged as not caught up — which is what `requireCaughtUp` refuses.
    expect(outcome.caughtUp).toBe(false)
    expect(waited).toBeLessThan(2_000)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('spends under a deadline far below the default, so a refusal is not preceded by a long wait', () => {
    expect(SPEND_CATCH_UP_TIMEOUT_MS).toBeLessThan(30_000)
  })
})

describe('awaitFeedCaughtUp', () => {
  it('hands back the projection once the replay lands', async () => {
    const {factory} = scripted([progress(1), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    const live = await Effect.runPromise(awaitFeedCaughtUp(key, 2_000))
    expect(live?.caughtUp).toBe(true)
    expect(live?.utxos.size).toBe(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('answers undefined rather than a partial projection when the feed does not get there', async () => {
    // The distinction a deferring caller needs: "the feed says this" versus "the feed never answered".
    // Handing back a half-replayed set as though it were complete is how a send picks inputs that are
    // already spent.
    const {factory} = scripted([progress(9), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    // The feed has a set, but the indexer named a higher id than the replay reached.
    expect((await liveFor(key))?.caughtUp).toBe(false)
    expect(await Effect.runPromise(awaitFeedCaughtUp(key, 60))).toBeUndefined()
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('answers undefined for a key no feed owns', async () => {
    expect(await Effect.runPromise(awaitFeedCaughtUp(feedKey('nobody', 0, 'preprod'), 60))).toBeUndefined()
  })
})

describe('two consumers share one feed', () => {
  it('the first to leave does not take it from the second', async () => {
    // ⚠️ Observed on device before this was counted: the balance hook and the activity list both watch
    // the same wallet, and opening the UTxO screen then pressing back closed the feed. Nothing reopened
    // it, because the surviving consumer's effect had no dependency change to re-run on — so balances
    // sat still with no error anywhere.
    const {factory} = scripted([progress(0)])
    const key = feedKey(GROUP, 0, 'preprod')
    const start = () =>
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      })
    await Effect.runPromise(start())
    await Effect.runPromise(start())
    await settle()
    expect(feedReaders(key)).toBe(2)

    await Effect.runPromise(stopUnshieldedFeed(key))
    expect(feedOwns(key)).toBe(true)
    expect(await liveFor(key)).toBeDefined()

    await Effect.runPromise(stopUnshieldedFeed(key))
    expect(feedOwns(key)).toBe(false)
    expect(await liveFor(key)).toBeUndefined()
  })

  it('two starts in the same tick open one socket, not two', async () => {
    // ⚠️ `fibers` alone could not guard this: the check happens before the cache read and the
    // registration after it, so both callers passed and the second orphaned the first fiber with its
    // socket never closed. Seen on device as two "feed opened" lines and no "closed".
    const {factory, opened} = scripted([progress(0)])
    const key = feedKey(GROUP, 0, 'preprod')
    const start = () =>
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      })
    // Concurrently, not sequentially — sequential starts were already safe.
    await Effect.runPromise(Effect.all([start(), start()], {concurrency: 'unbounded'}))
    await settle()
    expect(feedReaders(key)).toBe(2)
    // ⚠️ Sockets **created**, not closed. An orphaned fiber is not in `fibers`, so `stopAll` never
    // interrupts it and its socket never closes — which makes a close-count assertion pass either way.
    // That is how the first version of this test passed with the guard removed.
    expect(opened()).toBe(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('a start that could not open leaves no phantom reader behind', async () => {
    // Otherwise its later `stop` decrements a count it never contributed to, taking the feed down
    // under whoever does hold one.
    const key = feedKey(GROUP, 0, 'nosuchnet')
    await Effect.runPromise(
      Effect.either(startUnshieldedFeed({groupId: GROUP, accountIndex: 0, address: ADDRESS, network: 'nosuchnet'})),
    )
    expect(feedReaders(key)).toBe(0)
  })

  it('stopAll clears the counts, so a later start is not held open by ghosts', async () => {
    const {factory} = scripted([progress(0)])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    await Effect.runPromise(stopAllUnshieldedFeeds())
    expect(feedReaders(key)).toBe(0)
  })
})

describe('when the feed ends on its own', () => {
  const start = (factory: SocketFactory) =>
    Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )

  it('reopens the socket rather than leaving the wallet stale', async () => {
    // ⚠️ The defect this replaces: a clean end tore the feed down and *nothing restarted it*. A dead
    // feed was detected — `feedOwns` gates on the heartbeat — and a consumer mounting started a new
    // one, so it self-healed on navigation. A screen sitting still just stopped updating, silently, for
    // as long as the user left it there.
    const {factory, opened} = scripted([progress(0), {type: 'complete'}])
    await start(factory)
    await settle()
    expect(opened()).toBe(1)
    await afterBackoff()
    expect(opened()).toBeGreaterThan(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('keeps the key while it is reconnecting, and releases it once it is stopped', async () => {
    // The previous contract was that a clean end releases the key immediately. It no longer does,
    // because the feed is coming back in a second — and `feedOwns` still gates on the heartbeat, so a
    // reconnect that keeps failing past FEED_SILENCE_LIMIT_MS hands the one-shot back its turn anyway.
    const {factory} = scripted([progress(0), {type: 'complete'}])
    const key = feedKey(GROUP, 0, 'preprod')
    await start(factory)
    await settle()
    expect(feedRegistered(key)).toBe(true)
    await Effect.runPromise(stopAllUnshieldedFeeds())
    expect(feedRegistered(key)).toBe(false)
  })

  it('resumes from what the fold reached, not from where the feed started', async () => {
    // ⚠️ **The whole correctness of a reconnect.** Resubscribing from the feed's opening cursor would
    // replay the session on every drop; resubscribing from `state.highestTransactionId` — the field the
    // cache is written with — would *skip* everything between the id the indexer named and the one this
    // fold actually reached, which is a silent hole in the history rather than a slow reconnect.
    // The socket dies **mid-replay**, which is the only scenario that tells the three candidate cursors
    // apart: the feed opened at 0, the indexer named 5, and this fold reached 2. Only 2 is correct.
    const {factory, cursors} = scripted(
      [],
      [
        [progress(5), tx(1, [utxo()]), tx(2, [utxo({outputIndex: 1})]), {type: 'complete'}],
        // Second socket: say nothing, so only the cursor it asked for is under test.
        [],
      ],
    )
    await start(factory)
    await settle()
    expect(cursors()).toEqual([0])
    await afterBackoff()
    expect(cursors()[1]).toBe(2)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('does not stack a lock listener per reconnect', async () => {
    // ⚠️ The listener is registered once for the feed, outside the reconnect loop. Registering it per
    // attempt would grow the set for as long as the app runs, and nothing would look wrong: they fire
    // in insertion order and the live one runs last. That is how the original leak hid.
    const {factory, opened} = scripted([progress(0), {type: 'complete'}])
    await start(factory)
    await settle()
    expect(lockListenerCount()).toBe(1)
    await afterBackoff()
    expect(opened()).toBeGreaterThan(1)
    expect(lockListenerCount()).toBe(1)
    await Effect.runPromise(stopAllUnshieldedFeeds())
    expect(lockListenerCount()).toBe(0)
  })

  it('reports why the socket ended without a stack trace', async () => {
    // ⚠️ On device a `SubscriptionError`'s `String(cause)` renders ~3 KB of Hermes bundle URLs. That was
    // tolerable when a lost feed was logged once; the loop reports every attempt, so it would emit that
    // twice a minute per wallet for the length of an outage. Measured on the emulator, not guessed.
    // A socket that *errors*, not one that closes cleanly — only the failure path carries a stack, so a
    // clean end would leave this test unable to fail.
    const {factory, fail} = scripted([progress(1), tx(1, [utxo()])])
    await start(factory)
    await settle()
    fail()
    await settle()
    const warned = vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).includes('lost its socket'))
    expect(warned.length).toBeGreaterThan(0)
    for (const [, meta] of warned) {
      const cause = String((meta as {cause?: unknown} | undefined)?.cause ?? '')
      expect(cause).not.toContain('index.bundle')
      expect(cause.length).toBeLessThan(200)
    }
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('a replayed transaction does not double its activity', async () => {
    // ⚠️ The reconnect keeps one fold across sockets, so a resume that re-delivers a transaction the
    // fold already applied appends its parts a second time — and `foldedActivity` *merges* parts of one
    // transaction on purpose (a sponsored payout arrives twice and must read as one row). Merging is
    // explicitly not idempotent, so the second copy is summed into the first and the row shows double.
    // Seen on device: a -1,000 NIGHT row became -2,000 NIGHT after a reconnect, with the balance right.
    const {factory, fail} = scripted(
      [],
      [
        [progress(1), tx(1, [utxo()])],
        // The resume re-delivers the boundary transaction.
        [progress(1), tx(1, [utxo()])],
      ],
    )
    await start(factory)
    await settle()
    const key = feedKey(GROUP, 0, 'preprod')
    const first = (await liveFor(key))?.activity
    expect(first?.length).toBe(1)
    const netBefore = first?.[0]?.netByToken.get(NIGHT)
    // Guard the guard: a row whose net is absent would make the comparison below vacuous.
    expect(netBefore).toBe(1_000_000n)
    fail()
    await settle()
    await afterBackoff()
    const after = (await liveFor(key))?.activity
    expect(after?.length).toBe(1)
    expect(after?.[0]?.netByToken.get(NIGHT)).toBe(netBefore)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('keeps the history a reconnect does not re-deliver', async () => {
    // ⚠️ The other half of the carried layer. The socket dies **mid-replay**, so nothing was cached —
    // `caughtUp` is false and the feed writes once at catch-up — and the resume returns only what came
    // after its cursor. Without carrying the earlier rows forward, the two transactions folded before
    // the drop would simply vanish from the list, with no error anywhere.
    const {factory, fail} = scripted(
      [],
      [[progress(3), tx(1, [utxo()]), tx(2, [utxo({outputIndex: 1})])], [tx(3, [utxo({outputIndex: 2})])]],
    )
    await start(factory)
    await settle()
    const key = feedKey(GROUP, 0, 'preprod')
    expect((await liveFor(key))?.caughtUp).toBe(false)
    expect(saved.length).toBe(0)
    fail()
    await settle()
    await afterBackoff()
    const after = await liveFor(key)
    expect(after?.activity.map((a) => a.transactionId).sort()).toEqual([1, 2, 3])
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('backs off, and stops climbing at the indexer heartbeat interval', () => {
    // A permanently unreachable indexer must not be polled faster than a healthy one talks.
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })
})

describe('the indexer heartbeat', () => {
  it('a repeated progress frame is not news: no write, no settle, no re-render', async () => {
    // ⚠️ Measured against preprod: a caught-up address receives the *same* progress frame every 30
    // seconds, for ever. The one-shot never saw it because it closed at catch-up. Treating it as an
    // event cost a full serialise of the UTxO set and the whole activity history, a settle, a lock
    // read and a fresh projection identity — so every screen re-rendered — twice a minute, per wallet.
    const {factory, push} = scripted([progress(1), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect(saved.length).toBe(1)
    const first = await liveFor(key)

    push(progress(1))
    push(progress(1))
    await settle()

    expect(saved.length).toBe(1)
    // Same object, so `useSyncExternalStore` does not re-render a single consumer.
    expect(await liveFor(key)).toBe(first)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('still writes when a transaction actually arrives after the heartbeats', async () => {
    const {factory, push} = scripted([progress(1), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    push(progress(1))
    await settle()
    push(tx(2, [utxo({intentHash: 'bb22'})]))
    await settle()
    expect(saved.length).toBe(2)
    expect((await liveFor(key))?.utxos.size).toBe(2)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})

describe('a socket that goes quiet without closing', () => {
  it('stops owning the key, so a send re-reads instead of trusting a frozen projection', async () => {
    // ⚠️ A half-open socket — backgrounded phone, NAT rebind, network change — fires no `close` and no
    // `error`. The fiber lives on, and before this gate `feedOwns` stayed true: `syncUnshieldedWallet`
    // deferred to a projection that had stopped moving and a send selected from a stale UTxO set. The
    // one-shot it replaced always re-read from the wire.
    const {factory} = scripted([progress(1), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    expect(feedOwns(key)).toBe(true)

    // Three missed heartbeats later, with the fiber still alive and the projection still published.
    const later = Date.now() + FEED_SILENCE_LIMIT_MS + 1_000
    expect(feedOwns(key, later)).toBe(false)
    expect(feedRegistered(key)).toBe(true)
    expect(await liveFor(key)).toBeDefined()

    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('a heartbeat keeps it live even though it is not news', async () => {
    // The gate reads liveness from *any* frame. A heartbeat writes nothing and re-renders nothing, but
    // it is the proof the socket is still there — which is the only reason it is worth receiving.
    const {factory, push} = scripted([progress(1), tx(1, [utxo()])])
    const key = feedKey(GROUP, 0, 'preprod')
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    const before = saved.length
    push(progress(1))
    await settle()
    expect(saved.length).toBe(before)
    expect(feedOwns(key, Date.now() + FEED_SILENCE_LIMIT_MS - 5_000)).toBe(true)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})

describe('awaitFeedCaughtUp', () => {
  it('gives up on the deadline it was given, rather than its default', async () => {
    // ⚠️ What a money path depends on. `syncUnshieldedWallet`'s `timeoutMs` used to reach only the
    // one-shot socket, so a caller asking not to be kept waiting was obeyed on one path and ignored on
    // this one — the slower of the two, because it waits out a replay instead of starting one. A send
    // then blocked for the full default and answered `not-ready` anyway.
    const {factory} = scripted([progress(9), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    const key = feedKey(GROUP, 0, 'preprod')
    // The indexer named 9 and sent one transaction, so the replay is genuinely unfinished.
    expect((await liveFor(key))?.caughtUp).toBe(false)
    const startedAt = performance.now()
    const answer = await Effect.runPromise(awaitFeedCaughtUp(key, 120))
    const waited = performance.now() - startedAt
    expect(answer).toBeUndefined()
    expect(waited).toBeLessThan(2_000)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })

  it('answers at once when the feed is already caught up', async () => {
    const {factory} = scripted([progress(1), tx(1, [utxo()])])
    await Effect.runPromise(
      startUnshieldedFeed({
        groupId: GROUP,
        accountIndex: 0,
        address: ADDRESS,
        network: 'preprod',
        socketFactory: factory,
      }),
    )
    await settle()
    const answer = await Effect.runPromise(awaitFeedCaughtUp(feedKey(GROUP, 0, 'preprod'), 120))
    expect(answer?.caughtUp).toBe(true)
    await Effect.runPromise(stopAllUnshieldedFeeds())
  })
})
