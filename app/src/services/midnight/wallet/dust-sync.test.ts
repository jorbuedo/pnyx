import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

/**
 * `syncDust` had no test at all: it opens a socket and reaches the native bridge, so the whole tail
 * collapse and the block-time contract were verified by device runs alone. Both mocks below are for
 * *boundaries* this module owns — the indexer transport and the native ops — never for its own logic.
 *
 * ⚠️ The contract worth pinning is the one that decides whether a send is even offered: a block time
 * comes back **only** when the trees actually reached the tip. `0` is what keeps `decideFeePayer`
 * honest, and a `0` returned as a real timestamp would put "From your DUST" in front of a wallet that
 * cannot pay — the defect `02d84235` removed.
 */

const indexer = vi.hoisted(() => ({
  fetchGenerationEntries: vi.fn(),
  fetchSpentNullifiers: vi.fn(),
  fetchGenerationUpdate: vi.fn(),
  fetchCommitmentUpdate: vi.fn(),
  fetchDustTreeTip: vi.fn(),
}))

const native = vi.hoisted(() => ({
  dustStateNew: vi.fn(),
  dustNullifiers: vi.fn(),
  dustRemoveUtxos: vi.fn(),
  dustApplyDtimeUpdate: vi.fn(),
  dustApplyGeneration: vi.fn(),
  dustApplyGenerationCollapsedUpdate: vi.fn(),
  dustApplyCommitmentCollapsedUpdate: vi.fn(),
  spendableDustAt: vi.fn(),
  dustReplayEvents: vi.fn(),
}))

vi.mock('./dust-indexer', async () => {
  const actual = await vi.importActual<typeof import('./dust-indexer')>('./dust-indexer')
  return {
    ...actual,
    fetchGenerationEntries: (...args: readonly unknown[]) => Effect.succeed(indexer.fetchGenerationEntries(...args)),
    fetchGenerationUpdate: (...args: readonly unknown[]) => Effect.succeed(indexer.fetchGenerationUpdate(...args)),
    fetchCommitmentUpdate: (...args: readonly unknown[]) => Effect.succeed(indexer.fetchCommitmentUpdate(...args)),
    // `null` means "fail the typed channel", mirroring the real function. ⚠️ Throwing from the mock
    // instead would raise a *defect*, which `Effect.either` does not recover — so the test would fail
    // for a reason the production path cannot produce.
    fetchSpentNullifiers: (...args: readonly unknown[]) => {
      const spent = indexer.fetchSpentNullifiers(...args)
      return spent === null
        ? Effect.fail(new actual.DustIndexerError({cause: 'http', reason: 'socket refused'}))
        : Effect.succeed(spent)
    },
    fetchDustTreeTip: (...args: readonly unknown[]) => {
      const tip = indexer.fetchDustTreeTip(...args)
      return tip === null
        ? Effect.fail(new actual.DustIndexerError({cause: 'http', reason: 'no tip'}))
        : Effect.succeed(tip)
    },
  }
})

vi.mock('@pnyx/midnight-native', () => ({
  dustStateNew: () => Promise.resolve(native.dustStateNew()),
  dustNullifiers: (...args: readonly unknown[]) => Promise.resolve(native.dustNullifiers(...args)),
  dustRemoveUtxos: (...args: readonly unknown[]) => Promise.resolve(native.dustRemoveUtxos(...args)),
  dustApplyDtimeUpdate: (...args: readonly unknown[]) => Promise.resolve(native.dustApplyDtimeUpdate(...args)),
  dustApplyGeneration: (...args: readonly unknown[]) => Promise.resolve(native.dustApplyGeneration(...args)),
  dustApplyGenerationCollapsedUpdate: (...args: readonly unknown[]) =>
    Promise.resolve(native.dustApplyGenerationCollapsedUpdate(...args)),
  dustApplyCommitmentCollapsedUpdate: (...args: readonly unknown[]) =>
    Promise.resolve(native.dustApplyCommitmentCollapsedUpdate(...args)),
  spendableDustAt: (...args: readonly unknown[]) => Promise.resolve(native.spendableDustAt(...args)),
  dustReplayEvents: (...args: readonly unknown[]) => Promise.resolve(native.dustReplayEvents(...args)),
  // The roots the synced state hashes to. Tagged on the real side — 32 ASCII bytes, so 64 hex
  // characters the caller slices off — so the fixture carries a 64-character prefix too, or the
  // comparison would be measuring the mock's shape rather than the sync's behaviour.
  dustTreeRoots: () => Promise.resolve(treeRoots),
}))

const TAG = 'g'.repeat(64)
/** Matches the tip fixture by default; a test that wants a divergent state overwrites it. */
let treeRoots: {generation: string | null; commitment: string | null; syncTime: number} = {
  generation: `${TAG}aa`,
  commitment: `${TAG}bb`,
  syncTime: 0,
}

const {syncDust} = await import('./dust-sync')

beforeEach(() => {
  treeRoots = {generation: `${TAG}aa`, commitment: `${TAG}bb`, syncTime: 0}
})

const BLANK = new Uint8Array([0])
const AFTER_ENTRY = new Uint8Array([1])
const AFTER_TAIL = new Uint8Array([2])

/** One entry of ours at index 4, so the tail is the range above it. */
const entry = {
  generationIndex: 4,
  commitmentIndex: 4,
  value: 10n,
  initialValue: 10n,
  ctime: 1_700_000_000,
  seq: 0,
  backingNight: new Uint8Array(32),
  dtime: null,
}

const update = (startIndex: number, endIndex: number) => ({
  startIndex,
  endIndex,
  update: new Uint8Array([9]),
  protocolVersion: 1,
})

const tip = {
  blockHeight: 100,
  blockTimeSecs: 1_787_490_528,
  // Exclusive: the last leaf is 9, so the tail is 5..9.
  generationEndIndex: 10,
  commitmentEndIndex: 10,
  generationRoot: 'aa',
  commitmentRoot: 'bb',
}

const run = () =>
  Effect.runPromise(
    Effect.either(
      syncDust({
        indexerUrl: 'https://indexer.example',
        dustAddress: 'mn_dust_addr',
        dustRoleKey: new Uint8Array(32),
        atUnixSecs: 1_787_490_600n,
        spentDustBefore: false,
      }),
    ),
  )

beforeEach(() => {
  vi.clearAllMocks()
  indexer.fetchGenerationEntries.mockReturnValue({entries: [entry], dtimeUpdates: []})
  indexer.fetchGenerationUpdate.mockImplementation((_url, start, end) => update(start, end))
  indexer.fetchCommitmentUpdate.mockImplementation((_url, start, end) => update(start, end))
  indexer.fetchDustTreeTip.mockReturnValue(tip)
  native.dustStateNew.mockReturnValue(BLANK)
  native.dustApplyGeneration.mockReturnValue(AFTER_ENTRY)
  native.dustApplyGenerationCollapsedUpdate.mockReturnValue(AFTER_TAIL)
  native.dustApplyCommitmentCollapsedUpdate.mockReturnValue(AFTER_TAIL)
  native.spendableDustAt.mockReturnValue({balance: 5n, utxos: 1, syncTime: 0})
  native.dustApplyDtimeUpdate.mockReturnValue(new Uint8Array([3]))
  native.dustNullifiers.mockReturnValue(['aa', 'bb'])
  native.dustRemoveUtxos.mockReturnValue(new Uint8Array([9]))
  native.dustReplayEvents.mockReturnValue(new Uint8Array([7]))
  indexer.fetchSpentNullifiers.mockReturnValue([])
})

describe('the gap below our own entry', () => {
  // Distinct from the tail on purpose: a range the wallet needs to reach its own leaf is a hard failure,
  // because proceeding would insert at the wrong index. The tail is best-effort.
  it('fails the sync when the indexer cannot fill it', async () => {
    indexer.fetchGenerationUpdate.mockImplementation((_url, start, end) => (start === 0 ? null : update(start, end)))
    const result = await run()
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left.cause).toBe('missing-update')
  })
})

describe('the tail collapse', () => {
  it('asks for the range above our last leaf, with an exclusive end', async () => {
    await run()
    // Our entry sits at 4, so the trees are at 5 and the chain's last leaf is 9. Asking for 10 — the
    // end index itself — fails as "attempted update on updated sub-tree", which reads like a refusal of
    // forward collapsing rather than of one index past the end.
    expect(indexer.fetchGenerationUpdate).toHaveBeenCalledWith('https://indexer.example', 5, 9)
    expect(indexer.fetchCommitmentUpdate).toHaveBeenCalledWith('https://indexer.example', 5, 9)
  })

  it('returns the tip block’s time, and the state the collapse produced', async () => {
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.syncTimeSecs).toBe(tip.blockTimeSecs)
    expect(result.right.state).toBe(AFTER_TAIL)
  })

  /**
   * ⚠️ **A state whose trees are not the block's is not spendable, and must not claim to be.**
   *
   * A DUST spend proof carries these roots and the node resolves them under the `ctime` the spend
   * declares, so a state that hashes to something the chain never published produces a transaction
   * refused as `Custom error: 170` every time. Measured on preprod 2026-09-06: this wallet's generation
   * root matched none of 3,000 blocks while every leaf it owned matched, and every self-funded send was
   * built, approved, refused and silently re-sent through the sponsor.
   *
   * `0` rather than a new flag: it is this file's existing signal for "cannot pay a fee", and
   * `decideFeePayer` already refuses on it by name.
   */
  it('withholds the block time when the trees do not match the chain at that block', async () => {
    treeRoots = {generation: `${TAG}ff`, commitment: `${TAG}bb`, syncTime: 0}
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.syncTimeSecs).toBe(0)
    expect(result.right.collapsedAtHeight).toBe(0)
    // The state itself is still returned and still correct for reading a balance — only the promise
    // that it can pay a fee is withheld.
    expect(result.right.state).toBe(AFTER_TAIL)
  })

  /**
   * ⚠️ **The roots are consumed by exactly one thing: a DUST spend proof.** A wallet holding no
   * spendable output cannot build one, so collapsing its trees forward answers a question nobody
   * asks — while costing two indexer fetches a tick and logging the root mismatch at `error` every
   * 90 seconds for the life of a wallet that never registered for DUST. Observed on a device
   * 2026-09-11.
   */
  it('does not collapse forward for a wallet with no dust output to spend', async () => {
    native.spendableDustAt.mockReturnValue({balance: 0n, utxos: 0, syncTime: 0})
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(indexer.fetchDustTreeTip).not.toHaveBeenCalled()
    expect(result.right.syncTimeSecs).toBe(0)
    expect(result.right.collapsedAtHeight).toBe(0)
  })

  it('keeps the block time when both roots match', async () => {
    treeRoots = {generation: `${TAG}aa`, commitment: `${TAG}bb`, syncTime: 0}
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.syncTimeSecs).toBe(tip.blockTimeSecs)
  })
})

describe('what happens when it cannot reach the tip', () => {
  // ⚠️ The contract this file exists for. A block time is a promise that a spend's declared `ctime` has
  // roots the node agrees with; without the collapse there is no such instant, and `0` is what makes
  // `decideFeePayer` say "Paid for you" instead of promising otherwise.
  it('returns no block time when the indexer has no update for the tail', async () => {
    // ⚠️ Only the *tail* range. A null for the gap **below** our own entry is a different failure and a
    // hard one — the wallet cannot reach its own leaf — and mocking both at once hides that distinction.
    indexer.fetchGenerationUpdate.mockImplementation((_url, start, end) => (start === 5 ? null : update(start, end)))
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.syncTimeSecs).toBe(0)
  })

  it('returns no block time when the tip cannot be read, and still reports the balance', async () => {
    indexer.fetchDustTreeTip.mockReturnValue(null)
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.syncTimeSecs).toBe(0)
    // The balance does not depend on the collapse; only self-funding does. Failing the whole sync would
    // take a correct figure off the screen for a capability the user may not be using.
    expect(result.right.balance.balance).toBe(5n)
  })

  it('keeps the pre-collapse state when the collapse does not happen', async () => {
    indexer.fetchCommitmentUpdate.mockImplementation((_url, start, end) => (start === 5 ? null : update(start, end)))
    const result = await run()
    if (result._tag !== 'Right') throw new Error('expected a result')
    expect(result.right.state).toBe(AFTER_ENTRY)
  })
})

describe('advancing a stored state instead of rebuilding it', () => {
  const STORED = new Uint8Array([42])

  const resume = (over: Partial<{nextGeneration: number; nextCommitment: number}> = {}) => ({
    state: STORED,
    cursor: {nextGeneration: 5, nextCommitment: 5, ...over},
  })

  const advance = (spentDustBefore: boolean) =>
    Effect.runPromise(
      Effect.either(
        syncDust({
          indexerUrl: 'https://indexer.example',
          dustAddress: 'mn_dust_addr',
          dustRoleKey: new Uint8Array(32),
          atUnixSecs: 1_787_490_600n,
          spentDustBefore,
          resume: resume(),
        }),
      ),
    )

  // ⚠️ **The whole point.** A spend leaves successors the per-address feed does not carry, which makes a
  // *rebuild* wrong — and that refusal used to be applied to every sync, so a wallet lost DUST syncing
  // for ever the first time it paid a fee. The stored state already holds those successors.
  it('is allowed for a wallet that has spent DUST', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({entries: [], dtimeUpdates: []})
    const result = await advance(true)
    expect(result._tag).toBe('Right')
  })

  it('starts from the stored state, never from a blank one', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({entries: [], dtimeUpdates: []})
    await advance(false)
    // Nothing new to insert, so the state reaching the collapse is the one that came off disk.
    expect(native.dustStateNew).not.toHaveBeenCalled()
    expect(native.dustApplyGenerationCollapsedUpdate).toHaveBeenCalledWith(STORED, expect.anything())
  })

  it('reports the cursor it advanced to, so the next run resumes from there', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({entries: [], dtimeUpdates: []})
    const result = await advance(false)
    if (result._tag !== 'Right') throw new Error('expected a result')
    // The tail collapse reached the tip's last leaf, 9, so both trees now expect 10.
    expect(result.right.cursor).toEqual({nextGeneration: 10, nextCommitment: 10})
  })
})

describe('a dtime update on a leaf already in the tree', () => {
  const EVIDENCE = new Uint8Array([77])
  const dtimeUpdate = {generationIndex: 2, newDtime: 1_787_000_000, treeInsertionPath: EVIDENCE}

  const advance = () =>
    Effect.runPromise(
      Effect.either(
        syncDust({
          indexerUrl: 'https://indexer.example',
          dustAddress: 'mn_dust_addr',
          dustRoleKey: new Uint8Array(32),
          atUnixSecs: 1n,
          spentDustBefore: false,
          resume: {state: new Uint8Array([42]), cursor: {nextGeneration: 5, nextCommitment: 5}},
        }),
      ),
    )

  // ⚠️ The feed is read from 0 even on an advance: it filters by generation index, and the leaf whose
  // backing NIGHT moved is *below* the cursor, so starting at the cursor would never deliver its update.
  it('reads the whole feed on an advance, not just the range above the cursor', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({entries: [], dtimeUpdates: [dtimeUpdate]})
    await advance()
    expect(indexer.fetchGenerationEntries).toHaveBeenCalledWith('https://indexer.example', 'mn_dust_addr', 0, 4_000_000)
  })

  it('replaces the leaf instead of re-inserting it', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({entries: [], dtimeUpdates: [dtimeUpdate]})
    await advance()
    expect(native.dustApplyDtimeUpdate).toHaveBeenCalledWith(new Uint8Array([42]), EVIDENCE)
    // A leaf that is already there cannot be inserted again; the ledger refuses it.
    expect(native.dustApplyGeneration).not.toHaveBeenCalled()
  })

  // ⚠️ Every leaf the chain published evidence for, wherever it sits. A generation leaf we build
  // ourselves was measured differing from the chain's while the commitment leaf matched, so the
  // reconstruction is wrong in a field only that leaf carries — and the evidence holds the chain's leaf
  // outright, which is a stronger guarantee than fixing whichever field it turns out to be.
  it('applies evidence for updates above the cursor too', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({
      entries: [entry],
      dtimeUpdates: [{...dtimeUpdate, generationIndex: 6}],
    })
    await advance()
    expect(native.dustApplyDtimeUpdate).toHaveBeenCalledTimes(1)
  })

  // ⚠️ Asserts the sync **succeeded** as well as not inserting. Without the success check this passed
  // for the wrong reason: an unfiltered entry below the cursor trips the ordering guard, so the sync
  // failed instead of inserting and "was not inserted" stayed true.
  it('skips entries below the cursor rather than re-inserting them, and still succeeds', async () => {
    indexer.fetchGenerationEntries.mockReturnValue({
      entries: [{...entry, generationIndex: 1, commitmentIndex: 1}],
      dtimeUpdates: [],
    })
    const result = await advance()
    expect(result._tag).toBe('Right')
    expect(native.dustApplyGeneration).not.toHaveBeenCalled()
  })
})

// ⚠️ The rule the callers apply, asserted here because it is the one that decides which path a real
// wallet takes: a rebuild is the only path measured equal to the chain's roots, so it wins whenever it
// is available. An unspent wallet with a perfectly good cursor must still rebuild.
describe('which path a caller should choose', () => {
  it('an unspent wallet rebuilds, and still takes the chain own leaves', async () => {
    // The callers express the preference by not passing `resume` unless the wallet has spent. A rebuild
    // inserts its own leaves *and then* replaces the ones the chain published evidence for — which is
    // the order that matters: `update_from_evidence` needs a leaf already in the tree.
    indexer.fetchGenerationEntries.mockReturnValue({
      entries: [entry],
      dtimeUpdates: [{generationIndex: 2, newDtime: 1, treeInsertionPath: new Uint8Array([1])}],
    })
    const result = await run()
    expect(result._tag).toBe('Right')
    expect(native.dustApplyGeneration).toHaveBeenCalled()
    expect(native.dustApplyDtimeUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('outputs the chain has already spent', () => {
  // ⚠️ Observed on device: a wallet whose DUST the `harness/` scripts spent has no `dust-spent` flag, so
  // the state held retired outputs — a spend of one proved fine and was refused at submit with `196`,
  // and until then its value inflated the balance.
  it('drops the ones the chain reports spent', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue([
      {nullifier: 'aa', commitment: 'cc', blockHeight: 1, transactionId: 2},
    ])
    const result = await run()
    expect(result._tag).toBe('Right')
    expect(native.dustRemoveUtxos).toHaveBeenCalledWith(expect.anything(), [new Uint8Array([0xaa])])
  })

  it('leaves the state alone when the chain reports none', async () => {
    const result = await run()
    expect(result._tag).toBe('Right')
    expect(native.dustRemoveUtxos).not.toHaveBeenCalled()
  })

  // Best-effort on purpose: a sync that produced a good state must not fail because the indexer was
  // unreachable, and the balance it reports is still the best available.
  it('keeps the state and the balance when the check cannot run', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue(null)
    const result = await run()
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.balance.balance).toBe(5n)
    expect(native.dustRemoveUtxos).not.toHaveBeenCalled()
  })

  it('asks nothing when the state holds no outputs', async () => {
    native.dustNullifiers.mockReturnValue([])
    await run()
    expect(indexer.fetchSpentNullifiers).not.toHaveBeenCalled()
  })
})

describe('a wallet that has spent DUST', () => {
  // A rebuild derives every nonce from `seq 0`, and a spend leaves a successor at `seq + 1` the
  // per-address feed does not carry. The chain does carry it, as the spending transaction's own
  // `DustSpendProcessed`, so the rebuild is run twice: once to learn which outputs are spent, once
  // replaying each spend at the commitment index the chain wrote its successor to.
  const runSpent = () =>
    Effect.runPromise(
      Effect.either(
        syncDust({
          indexerUrl: 'https://indexer.example',
          dustAddress: 'mn_dust_addr',
          dustRoleKey: new Uint8Array(32),
          atUnixSecs: 1_787_490_600n,
          spentDustBefore: true,
        }),
      ),
    )

  /** A spend whose successor landed at commitment 2 — below our own entry at 4, so it must interleave. */
  const repairable = [
    {
      nullifier: 'aa',
      commitment: 'cc',
      blockHeight: 90,
      transactionId: 7,
      commitmentStart: 2,
      commitmentEnd: 3,
      generationStart: 0,
      generationEnd: 0,
      spendEvents: ['abcd'],
    },
  ]

  /** The same spend as a caller would have persisted it. */
  const persisted = [
    {
      nullifier: 'aa',
      commitmentStart: 2,
      commitmentEnd: 3,
      generationStart: 0,
      generationEnd: 0,
      spendEvents: ['abcd'],
    },
  ]

  const runWith = (
    repairs: readonly {
      nullifier: string
      commitmentStart: number
      commitmentEnd: number
      generationStart: number
      generationEnd: number
      spendEvents: readonly string[]
    }[],
  ) =>
    Effect.runPromise(
      Effect.either(
        syncDust({
          indexerUrl: 'https://indexer.example',
          dustAddress: 'mn_dust_addr',
          dustRoleKey: new Uint8Array(32),
          atUnixSecs: 1_787_490_600n,
          spentDustBefore: true,
          repairs,
        }),
      ),
    )

  it('reinstates the successor of a spend it was given', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue([])
    const result = await runWith(persisted)
    expect(result._tag).toBe('Right')
    // The event the chain published, replayed verbatim — not a successor rebuilt from parts here.
    expect(native.dustReplayEvents).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      new Uint8Array([0xab, 0xcd]),
    ])
    // Dropping is what the repair replaces. If this is called, value was written off.
    expect(native.dustRemoveUtxos).not.toHaveBeenCalled()
  })

  it('advances the commitment tree to the successor before replaying, and only then inserts our entry', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue([])
    await runWith(persisted)
    // The successor sits at 2 and our entry at 4, so the walk must collapse 0..1, replay, then collapse
    // 3..3 before the entry. A repair applied after the loop could never land: the tree would already
    // be past it, and `insert_commitment` refuses a non-linear index.
    expect(indexer.fetchCommitmentUpdate).toHaveBeenCalledWith('https://indexer.example', 0, 1)
    expect(indexer.fetchCommitmentUpdate).toHaveBeenCalledWith('https://indexer.example', 3, 3)
    const replayOrder = native.dustReplayEvents.mock.invocationCallOrder[0]
    const entryOrder = native.dustApplyGeneration.mock.invocationCallOrder.at(-1)
    expect(replayOrder).toBeLessThan(entryOrder ?? 0)
  })

  it('reports a newly found spend for the next sync instead of chasing it now', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue(repairable)
    const result = await runWith([])
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    // ⚠️ One step per call. Discovery and application are separate rounds because a successor's
    // nullifier does not exist until the successor does — so this round hands the list forward rather
    // than blocking for minutes chasing a backlog.
    expect(result.right.moreToRepair).toBe(true)
    expect(result.right.repairs.map((one) => one.nullifier)).toEqual(['aa'])
    expect(native.dustReplayEvents).not.toHaveBeenCalled()
    // And the state stays safe meanwhile: an output the chain has spent is dropped, so selection cannot
    // pick it and build a proof the node refuses with `196`.
    expect(native.dustRemoveUtxos).toHaveBeenCalled()
  })

  it('replays a split-change spend instead of writing it off', async () => {
    // ⚠️ **The regression.** A self-funded send splits its NIGHT change, so the transaction writes one
    // commitment per chunk plus the successor — measured on preprod as ranges of 2, 3, 3, 10 and 10.
    // The old rule repaired only `end - start === 1`, which splitting makes unreachable, so every one
    // of those spends was dropped and its DUST orphaned. The batch is what removes the question.
    // Given, not discovered: a spend is applied on the round it is handed to, one step per sync.
    indexer.fetchSpentNullifiers.mockReturnValue([])
    const result = await runWith([
      {
        nullifier: 'aa',
        commitmentStart: 2,
        commitmentEnd: 12,
        generationStart: 0,
        generationEnd: 0,
        spendEvents: ['abcd', 'ef01'],
      },
    ])
    expect(result._tag).toBe('Right')
    expect(native.dustReplayEvents).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      new Uint8Array([0xab, 0xcd]),
      new Uint8Array([0xef, 0x01]),
    ])
    // Writing the value off is exactly what the repair replaces.
    expect(native.dustRemoveUtxos).not.toHaveBeenCalled()
  })

  it('drops a spend it can never reinstate, and still returns a correct state', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue([
      {
        ...repairable[0],
        commitmentStart: undefined,
        commitmentEnd: undefined,
        generationStart: undefined,
        generationEnd: undefined,
        spendEvents: [],
      },
    ])
    const result = await runSpent()
    // ⚠️ Deliberately not a refusal any more. Dropping removes the phantom `seq 0` output, so the state
    // is correct — what is lost is that output's value, permanently, because the transaction published
    // no commitment range and no events at all. ⚠️ A *wide* range is no longer this case: it is
    // replayed like any other, which is the whole point of the range form.
    expect(result._tag).toBe('Right')
    expect(native.dustRemoveUtxos).toHaveBeenCalled()
    expect(native.dustReplayEvents).not.toHaveBeenCalled()
  })

  it('accumulates a deeper spend onto the list it was given', async () => {
    // The next step along the same output's history: only once the seq-1 successor exists does its own
    // nullifier exist to be asked about. This round applies what it knows and appends what it found.
    const deeper = {
      nullifier: 'bb',
      commitment: 'dd',
      blockHeight: 95,
      transactionId: 9,
      commitmentStart: 3,
      commitmentEnd: 4,
      generationStart: 0,
      generationEnd: 0,
      spendEvents: ['ef01'],
    }
    indexer.fetchSpentNullifiers.mockReturnValue([...repairable, deeper])
    const result = await runWith(persisted)
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(native.dustReplayEvents).toHaveBeenCalledTimes(1)
    expect(result.right.moreToRepair).toBe(true)
    expect(result.right.repairs.map((one) => one.nullifier).sort()).toEqual(['aa', 'bb'])
  })

  it('reports nothing left to do when every spend it finds is already applied', async () => {
    // The steady state with a persisted list: one rebuild, nothing outstanding. Without the freshness
    // check the same spends would be re-reported for ever and the caller would never stop asking.
    indexer.fetchSpentNullifiers.mockReturnValue(repairable)
    const result = await runWith(persisted)
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(native.dustReplayEvents).toHaveBeenCalledTimes(1)
    expect(result.right.moreToRepair).toBe(false)
  })

  it('is refused when the chain cannot be asked which outputs are spent', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue(null)
    const result = await runSpent()
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    // Elsewhere an unreachable indexer is best-effort and the outputs stay. Here the pass existed to
    // find them, so returning the state would hand back exactly the seq-0 outputs it cannot vouch for.
    expect(result.left.cause).toBe('spent-before')
  })

  it('rebuilds normally when the chain reports nothing spent after all', async () => {
    indexer.fetchSpentNullifiers.mockReturnValue([])
    const result = await runSpent()
    // `dust-spent` records what this app did; the chain is the authority on what landed.
    expect(result._tag).toBe('Right')
    expect(native.dustReplayEvents).not.toHaveBeenCalled()
  })
})
