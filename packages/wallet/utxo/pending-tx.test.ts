import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createPendingTxTracker, type PendingTx} from './pending-tx.js'
import {utxoId} from './utxo.js'

const hashBytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)
const hashHex = (fill: number): string => Buffer.from(hashBytes(fill)).toString('hex')

const ADDRESS = EvolutionAddress.fromBech32(
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
)

/** ⚠️ A real bech32: Evolution's `UTxO` validates its address on construction. */
const utxo = (txFill: number, index: number, lovelace: bigint): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(hashHex(txFill)),
    index: BigInt(index),
    address: ADDRESS,
    assets: EvAssets.fromLovelace(lovelace),
  })

const pendingTx = (txFill: number, consumed: readonly UTxO.UTxO[], change: readonly UTxO.UTxO[]): PendingTx => ({
  txHash: hashHex(txFill),
  consumedUtxoIds: consumed.map(utxoId),
  change,
  submittedAt: 1_000,
})

const run = <A>(eff: Effect.Effect<A>): Promise<A> => Effect.runPromise(eff)

describe('createPendingTxTracker', () => {
  it('locks consumed utxos and exposes change as spendable', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        const confirmed = [utxo(0x01, 0, 5_000_000n), utxo(0x02, 0, 3_000_000n)]
        const change = utxo(0xaa, 0, 4_000_000n)
        yield* tracker.register(pendingTx(0xaa, [confirmed[0] as UTxO.UTxO], [change]))
        return yield* tracker.spendableView(confirmed)
      }),
    )
    expect(result.map(utxoId).sort()).toEqual([utxo(0x02, 0, 0n), utxo(0xaa, 0, 0n)].map(utxoId).sort())
  })

  it('confirm drops the overlay without disturbing the confirmed set', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        const spent = utxo(0x01, 0, 5_000_000n)
        const change = utxo(0xaa, 0, 4_000_000n)
        yield* tracker.register(pendingTx(0xaa, [spent], [change]))
        const known = yield* tracker.confirm(hashHex(0xaa))
        const unknown = yield* tracker.confirm(hashHex(0xbb))
        // post-confirm sync returns the real change utxo
        const view = yield* tracker.spendableView([change])
        return {known, unknown, view}
      }),
    )
    expect(result.known).toBe(true)
    expect(result.unknown).toBe(false)
    expect(result.view.map(utxoId)).toEqual([utxoId(utxo(0xaa, 0, 0n))])
  })

  it('chains: a dependent tx can spend pending change, which locks it', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        const confirmed = [utxo(0x01, 0, 5_000_000n)]
        const changeA = utxo(0xaa, 1, 4_000_000n)
        const changeB = utxo(0xbb, 1, 3_000_000n)
        yield* tracker.register(pendingTx(0xaa, confirmed, [changeA]))
        yield* tracker.register(pendingTx(0xbb, [changeA], [changeB]))
        return yield* tracker.spendableView(confirmed)
      }),
    )
    expect(result.map(utxoId)).toEqual([utxoId(utxo(0xbb, 1, 0n))])
  })

  it('rollback cascades to dependents', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        const confirmed = [utxo(0x01, 0, 5_000_000n)]
        const changeA = utxo(0xaa, 1, 4_000_000n)
        const changeB = utxo(0xbb, 1, 3_000_000n)
        yield* tracker.register(pendingTx(0xaa, confirmed, [changeA]))
        yield* tracker.register(pendingTx(0xbb, [changeA], [changeB]))
        const removed = yield* tracker.rollback(hashHex(0xaa))
        const view = yield* tracker.spendableView(confirmed)
        const remaining = yield* tracker.pending
        return {removed, view, remaining}
      }),
    )
    expect(result.removed).toEqual([hashHex(0xaa), hashHex(0xbb)])
    expect(result.remaining).toHaveLength(0)
    // the original confirmed utxo is spendable again
    expect(result.view.map(utxoId)).toEqual([utxoId(utxo(0x01, 0, 0n))])
  })

  it('sweep expires stale entries with cascade and keeps fresh ones', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        const confirmed = [utxo(0x01, 0, 5_000_000n), utxo(0x02, 0, 9_000_000n)]
        const changeA = utxo(0xaa, 1, 4_000_000n)
        yield* tracker.register({...pendingTx(0xaa, [confirmed[0] as UTxO.UTxO], [changeA]), submittedAt: 0})
        yield* tracker.register({...pendingTx(0xbb, [changeA], []), submittedAt: 50})
        yield* tracker.register({...pendingTx(0xcc, [confirmed[1] as UTxO.UTxO], []), submittedAt: 1_000_000})
        const removed = yield* tracker.sweep(1_000_100, 1_000)
        const remaining = yield* tracker.pending
        return {removed, remaining: remaining.map((t) => t.txHash)}
      }),
    )
    expect([...result.removed].sort()).toEqual([hashHex(0xaa), hashHex(0xbb)].sort())
    expect(result.remaining).toEqual([hashHex(0xcc)])
  })

  it('normalizes tx hash casing', async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* createPendingTxTracker()
        yield* tracker.register({...pendingTx(0xaa, [utxo(0x01, 0, 1n)], []), txHash: hashHex(0xaa).toUpperCase()})
        return yield* tracker.confirm(hashHex(0xaa))
      }),
    )
    expect(result).toBe(true)
  })
})

describe('expiry', () => {
  const withDeadline = (expiresAt: number): PendingTx => ({...pendingTx(1, [utxo(9, 0, 5n)], []), expiresAt})

  // The tx's own `invalid_hereafter` beats the timeout in both directions: releasing before it invites
  // a real double-spend, holding after it strands inputs the chain provably cannot take.
  it('keeps a tx until its own deadline, whatever the timeout says', async () => {
    const tracker = await run(createPendingTxTracker())
    await run(tracker.register(withDeadline(50_000)))

    // Far past the max age, but not past the deadline.
    await run(tracker.sweep(40_000, 1))

    expect(await run(tracker.pending)).toHaveLength(1)
  })

  it('drops a tx once its own deadline has passed, however recent', async () => {
    const tracker = await run(createPendingTxTracker())
    await run(tracker.register(withDeadline(2_000)))

    // Well inside the max age, but past the deadline.
    await run(tracker.sweep(2_001, 60 * 60 * 1000))

    expect(await run(tracker.pending)).toHaveLength(0)
  })

  it('falls back to the age timeout when the tx names no deadline', async () => {
    const tracker = await run(createPendingTxTracker())
    await run(tracker.register(pendingTx(1, [utxo(9, 0, 5n)], [])))

    // Submitted at 1,000: still inside a 1,000 ms window at 1,900, past it at 2,500.
    await run(tracker.sweep(1_900, 1_000))
    expect(await run(tracker.pending)).toHaveLength(1)

    await run(tracker.sweep(2_500, 1_000))
    expect(await run(tracker.pending)).toHaveLength(0)
  })
})

describe('persistence', () => {
  const makePort = (initial: {rows: unknown[]} = {rows: []}) => {
    const store = initial
    return {
      store,
      port: {
        load: () => Effect.succeed(store.rows as never),
        save: (rows: readonly unknown[]) =>
          Effect.sync(() => {
            store.rows = [...rows]
          }),
      },
    }
  }

  it('writes the locks out on register, confirm and sweep', async () => {
    const {store, port} = makePort()
    const tracker = await run(createPendingTxTracker(port))

    await run(tracker.register(pendingTx(1, [utxo(9, 0, 5n)], [utxo(1, 0, 4n)])))
    expect(store.rows).toHaveLength(1)

    await run(tracker.confirm(hashHex(1)))
    expect(store.rows).toHaveLength(0)
  })

  // A restart between submitting and the first sync that sees the tx used to free every input it
  // consumed, which is the window a second build could double-spend in.
  it('still locks a restored transaction’s inputs', async () => {
    const spent = utxo(9, 0, 5n)
    const {port} = makePort()
    await run(createPendingTxTracker(port).pipe(Effect.flatMap((t) => t.register(pendingTx(1, [spent], [])))))

    const revived = await run(createPendingTxTracker(port))

    expect(await run(revived.lockedUtxoIds)).toContain(utxoId(spent))
    expect(await run(revived.spendableView([spent]))).toEqual([])
  })

  // Ids round-trip; the persisted row deliberately stores only those, so chaining pauses across a
  // restart while correctness does not. See the module note for why that is now a choice.
  it('restores no virtual UTxOs, but still cascades through them', async () => {
    const spent = utxo(9, 0, 5n)
    const change = utxo(1, 0, 4n)
    const {port} = makePort()
    await run(
      createPendingTxTracker(port).pipe(
        Effect.flatMap((t) =>
          t
            .register(pendingTx(1, [spent], [change]))
            .pipe(Effect.flatMap(() => t.register(pendingTx(2, [change], [])))),
        ),
      ),
    )

    const revived = await run(createPendingTxTracker(port))
    expect(await run(revived.virtualUtxos)).toEqual([])

    // The dependent still goes when its parent does — `producedUtxoIds` carries what cascade needs.
    const removed = await run(revived.rollback(hashHex(1)))
    expect(removed).toHaveLength(2)
  })
})
