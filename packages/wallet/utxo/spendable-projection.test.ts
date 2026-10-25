import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import {lockedUtxoIdsOf, projectSpendable, type UtxoOverlayEntry, unconsumedChangeOf} from './spendable-projection.js'
import {utxoId} from './utxo.js'

const ADDRESS = EvolutionAddress.fromBech32(
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
)

/** ⚠️ A real bech32, not `addr_test1demo`: Evolution's `UTxO` validates its address on construction. */
const utxo = (txFill: number, index: number, lovelace: bigint): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(txFill.toString(16).padStart(2, '0').repeat(32)),
    index: BigInt(index),
    address: ADDRESS,
    assets: EvAssets.fromLovelace(lovelace),
  })

const entry = (consumed: readonly UTxO.UTxO[], change: readonly UTxO.UTxO[]): UtxoOverlayEntry => ({
  consumedUtxoIds: consumed.map(utxoId),
  change,
})

const ids = (utxos: readonly UTxO.UTxO[]): string[] => utxos.map(utxoId).sort()

describe('projectSpendable', () => {
  it('returns the base set unchanged when there are no entries', () => {
    const base = [utxo(0x01, 0, 5_000_000n), utxo(0x02, 0, 3_000_000n)]

    expect(ids(projectSpendable(base, []))).toEqual(ids(base))
  })

  it('removes consumed utxos and adds change', () => {
    const spent = utxo(0x01, 0, 5_000_000n)
    const kept = utxo(0x02, 0, 3_000_000n)
    const change = utxo(0xaa, 1, 4_000_000n)

    const view = projectSpendable([spent, kept], [entry([spent], [change])])

    expect(ids(view)).toEqual(ids([kept, change]))
  })

  it('lets a later entry chain onto an earlier entry change, locking it', () => {
    const confirmed = utxo(0x01, 0, 5_000_000n)
    const changeA = utxo(0xaa, 1, 4_000_000n)
    const changeB = utxo(0xbb, 1, 3_000_000n)

    const view = projectSpendable([confirmed], [entry([confirmed], [changeA]), entry([changeA], [changeB])])

    expect(ids(view)).toEqual(ids([changeB]))
  })

  it('collapses a just-confirmed change utxo to the base copy', () => {
    // Same id in both the base set and an entry's change: the base wins, so the
    // view does not double-count across the confirm transition.
    const spent = utxo(0x01, 0, 5_000_000n)
    const change = utxo(0xaa, 1, 4_000_000n)
    // A DISTINCT object with the same id, which is what makes `toBe` below meaningful: it proves
    // the base copy wins rather than the overlay's. The old fixture spread a `value` field onto
    // the change to make one; a `UTxO` is built, so this constructs an equal-but-separate one.
    const confirmedChange = utxo(0xaa, 1, 4_000_000n)

    const view = projectSpendable([confirmedChange], [entry([spent], [change])])

    expect(view).toHaveLength(1)
    expect(view[0]).toBe(confirmedChange)
  })

  it('composes by layering: one layer output is the next layer base', () => {
    // How the Send compose queue stacks on the pending overlay.
    const confirmed = utxo(0x01, 0, 10_000_000n)
    const pendingChange = utxo(0xaa, 1, 8_000_000n)
    const queuedChange = utxo(0xbb, 1, 6_000_000n)

    const afterPending = projectSpendable([confirmed], [entry([confirmed], [pendingChange])])
    const afterQueue = projectSpendable(afterPending, [entry([pendingChange], [queuedChange])])

    expect(ids(afterPending)).toEqual(ids([pendingChange]))
    expect(ids(afterQueue)).toEqual(ids([queuedChange]))
  })

  it('does not resurrect a base utxo that a later entry consumed', () => {
    const a = utxo(0x01, 0, 5_000_000n)
    const b = utxo(0x02, 0, 5_000_000n)

    const view = projectSpendable([a, b], [entry([a], []), entry([b], [])])

    expect(view).toEqual([])
  })
})

describe('lockedUtxoIdsOf', () => {
  it('unions consumed ids across entries', () => {
    const a = utxo(0x01, 0, 1n)
    const b = utxo(0x02, 0, 1n)

    const locked = lockedUtxoIdsOf([entry([a], []), entry([b], []), entry([a], [])])

    expect([...locked].sort()).toEqual([utxoId(a), utxoId(b)].sort())
  })
})

describe('unconsumedChangeOf', () => {
  it('omits change that a later entry already consumed', () => {
    const changeA = utxo(0xaa, 1, 4_000_000n)
    const changeB = utxo(0xbb, 1, 3_000_000n)

    const free = unconsumedChangeOf([entry([], [changeA]), entry([changeA], [changeB])])

    expect(ids(free)).toEqual(ids([changeB]))
  })
})
