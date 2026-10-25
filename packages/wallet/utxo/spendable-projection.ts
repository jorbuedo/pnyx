/**
 * The spendable-UTxO projection: how a set of not-yet-confirmed transactions
 * overlays a base UTxO set.
 *
 * Pure and independent of *why* a transaction is unconfirmed, so the same rule
 * serves both overlays: submitted-but-unconfirmed txs (`pending-tx.ts`) and
 * built-but-unsubmitted ones (the Send compose queue). Because the projection
 * is a fold over the base set, layering is composition — feed one layer's
 * output in as the next layer's base.
 *
 * Also independent of *which chain*: the UTxO type is a parameter and identity
 * comes from an `idOf` the caller supplies, so Midnight's unshielded set uses
 * the same rule rather than a second copy of it. Cardano passes `utxoId`.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {utxoId} from './utxo.js'

/**
 * The UTxO effect of one unconfirmed transaction: what it consumes, and the
 * outputs back to own addresses that dependents may spend.
 */
export type UtxoOverlayEntry<U = UTxO.UTxO> = {
  /** Id strings of the UTxOs this tx consumed (confirmed or virtual). */
  readonly consumedUtxoIds: readonly string[]
  /** This tx's outputs back to own addresses. */
  readonly change: readonly U[]
}

/** Every UTxO id consumed by some entry — unspendable while that tx stands. */
export const lockedUtxoIdsOf = (entries: Iterable<UtxoOverlayEntry<unknown>>): ReadonlySet<string> => {
  const locked = new Set<string>()
  for (const entry of entries) for (const id of entry.consumedUtxoIds) locked.add(id)
  return locked
}

/**
 * Entry change that no other entry has already consumed — the virtual UTxOs a
 * further transaction may chain onto.
 */
export const unconsumedChangeOf = <U = UTxO.UTxO>(
  entries: Iterable<UtxoOverlayEntry<U>>,
  locked?: ReadonlySet<string>,
  idOf: (utxo: U) => string = utxoId as unknown as (utxo: U) => string,
): readonly U[] => {
  const entryList = [...entries]
  const lockedIds = locked ?? lockedUtxoIdsOf(entryList)
  const out: U[] = []
  for (const entry of entryList) {
    for (const utxo of entry.change) if (!lockedIds.has(idOf(utxo))) out.push(utxo)
  }
  return out
}

/**
 * Overlay unconfirmed transactions on a base UTxO set: base − locked + virtual.
 *
 * Deduped by `utxoId` with the **base winning**, so a just-confirmed change
 * UTxO appearing in both collapses to the confirmed copy and the view stays
 * stable across that transition.
 */
export const projectSpendable = <U = UTxO.UTxO>(
  base: readonly U[],
  entries: Iterable<UtxoOverlayEntry<U>>,
  idOf: (utxo: U) => string = utxoId as unknown as (utxo: U) => string,
): readonly U[] => {
  const entryList = [...entries]
  const locked = lockedUtxoIdsOf(entryList)
  const byId = new Map<string, U>()
  for (const utxo of unconsumedChangeOf(entryList, locked, idOf)) byId.set(idOf(utxo), utxo)
  for (const utxo of base) byId.set(idOf(utxo), utxo)
  return [...byId.entries()].filter(([id]) => !locked.has(id)).map(([, utxo]) => utxo)
}

/**
 * How to read identity and UTxO flow off an entry, so {@link cascadeRemove}
 * works for any container of unconfirmed transactions.
 */
export type CascadeSpec<T> = {
  readonly keyOf: (entry: T) => string
  readonly consumedIdsOf: (entry: T) => readonly string[]
  /** Ids this entry produces — a dependent is anything consuming one of them. */
  readonly producedIdsOf: (entry: T) => readonly string[]
}

/**
 * Drop `roots` and everything transitively depending on them. A transaction
 * spending a dropped transaction's output is invalid by construction, so
 * removal has to cascade.
 *
 * `removedKeys` is breadth-first from `roots`, so the roots come first.
 */
export const cascadeRemove = <T>(
  entries: readonly T[],
  spec: CascadeSpec<T>,
  roots: readonly string[],
): {readonly removedKeys: readonly string[]; readonly kept: readonly T[]} => {
  const remaining = new Map(entries.map((entry) => [spec.keyOf(entry), entry]))
  const removedKeys: string[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) continue
    const entry = remaining.get(key)
    if (entry === undefined) continue
    remaining.delete(key)
    removedKeys.push(key)
    const orphaned = new Set(spec.producedIdsOf(entry))
    for (const [otherKey, other] of remaining) {
      if (spec.consumedIdsOf(other).some((id) => orphaned.has(id))) queue.push(otherKey)
    }
  }
  return {removedKeys, kept: [...remaining.values()]}
}
