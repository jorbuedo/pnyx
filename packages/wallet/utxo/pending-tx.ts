/**
 * Pending-transaction tracker — the UTxO side of tx chaining.
 *
 * A submitted-but-unconfirmed tx locks the UTxOs it consumed (so a second
 * build can't double-spend them) and exposes its own-address change as
 * *virtual* UTxOs that dependent txs may spend immediately (signAll legs,
 * back-to-back sends). `spendableView` overlays this on the confirmed set.
 *
 * Reconciliation: `confirm` drops the entry once the chain owns the truth
 * (the next sync returns the real change UTxOs under the same ids, so the
 * spendable view is stable across the transition). `rollback` drops the entry
 * AND cascades to dependents — any pending tx spending the rolled-back tx's
 * change is invalid by construction. `sweep` expires stale entries the same
 * way (a tx that never confirmed within the timeout is assumed dropped).
 *
 * ## Expiry prefers the transaction's own deadline
 *
 * `expiresAt` is `invalid_hereafter` translated to epoch millis: past it the
 * chain can never accept the tx, so its inputs are provably free. That beats
 * the timeout in both directions — releasing before it invites a real
 * double-spend, holding after it strands funds — and `DEFAULT_PENDING_TIMEOUT_MS`
 * remains only as the fallback for a tx that reports no deadline.
 *
 * ## Persistence keeps the locks, not the virtual UTxOs
 *
 * With a {@link PendingTxPersistence} port the locks outlive the process, which
 * matters because a restart between submitting and the first sync that sees the
 * tx would otherwise free every input it consumed. Only **ids** are stored.
 *
 * ⚠️ That used to be forced — the old `WalletUtxo` carried `datum` and `scriptRef` as `unknown`,
 * so a codec for it would have dropped data silently. Evolution's `UTxO` is a schema class and
 * round-trips, so ids-only is now a *choice*: the next sync returns the real UTxOs anyway, and
 * persisting a second copy would mean a storage migration for a value with a one-sync lifetime.
 * So a rehydrated entry
 * still locks its inputs and still cascades correctly — `producedUtxoIds`
 * carries what cascade needs — but exposes no virtual UTxOs until the next sync
 * returns the real ones. Chaining pauses across a restart; correctness does not.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Effect, Ref} from 'effect'
import {
  type CascadeSpec,
  cascadeRemove,
  lockedUtxoIdsOf,
  projectSpendable,
  type UtxoOverlayEntry,
  unconsumedChangeOf,
} from './spendable-projection.js'
import {utxoId} from './utxo.js'

export type PendingTx = UtxoOverlayEntry & {
  /** Tx id, hex (blake2b-256 of the body). */
  readonly txHash: string
  /** Epoch millis at submission — the fallback `sweep` uses when there is no deadline. */
  readonly submittedAt: number
  /**
   * Epoch millis of `invalid_hereafter`, when the tx names one.
   *
   * Preferred over the timeout: past it the chain provably cannot accept the tx.
   */
  readonly expiresAt?: number
  /**
   * Ids of the outputs this tx produced to own addresses.
   *
   * Normally derived from `change`; carried explicitly for a rehydrated entry, whose `change` is
   * empty because the persisted row stores ids only (see the module note).
   */
  readonly producedUtxoIds?: readonly string[]
}

/** One rehydratable row. Ids only — see the module note on why change is not stored. */
export type PersistedPendingTx = {
  readonly txHash: string
  readonly consumedUtxoIds: readonly string[]
  readonly producedUtxoIds: readonly string[]
  readonly submittedAt: number
  readonly expiresAt?: number
}

/**
 * Where the locks live between runs. Supplied by the app, so this package needs
 * no storage of its own.
 */
export type PendingTxPersistence = {
  readonly load: () => Effect.Effect<readonly PersistedPendingTx[]>
  readonly save: (rows: readonly PersistedPendingTx[]) => Effect.Effect<void>
}

/** A pending tx that never confirmed within the sweep window is assumed dropped. */
export const DEFAULT_PENDING_TIMEOUT_MS = 2 * 60 * 60 * 1000

export type PendingTxTracker = {
  /** Register a submitted tx: lock its inputs, expose its change. */
  readonly register: (tx: PendingTx) => Effect.Effect<void>
  /** The chain confirmed the tx — drop the overlay entry. False if unknown. */
  readonly confirm: (txHash: string) => Effect.Effect<boolean>
  /**
   * The tx was dropped/rolled back — remove it and every dependent pending tx
   * (transitively). Returns all removed tx hashes, the argument first.
   */
  readonly rollback: (txHash: string) => Effect.Effect<readonly string[]>
  readonly pending: Effect.Effect<readonly PendingTx[]>
  /** UTxO ids currently locked (consumed by an in-flight tx). */
  readonly lockedUtxoIds: Effect.Effect<ReadonlySet<string>>
  /** Pending change not itself consumed by a later pending tx. */
  readonly virtualUtxos: Effect.Effect<readonly UTxO.UTxO[]>
  /**
   * Overlay the pending set on the confirmed UTxOs: confirmed − locked +
   * virtual. Deduped by utxoId (a just-confirmed change UTxO may appear in
   * both — the confirmed copy wins).
   */
  readonly spendableView: (confirmed: readonly UTxO.UTxO[]) => Effect.Effect<readonly UTxO.UTxO[]>
  /** Roll back entries older than `maxAgeMs` (cascading). Returns removed hashes. */
  readonly sweep: (nowMs: number, maxAgeMs?: number) => Effect.Effect<readonly string[]>
}

const CASCADE_SPEC: CascadeSpec<PendingTx> = {
  keyOf: (tx) => tx.txHash,
  consumedIdsOf: (tx) => tx.consumedUtxoIds,
  // Explicit ids win, so a rehydrated entry still links to its dependents even
  // though its change objects were not stored.
  producedIdsOf: (tx) => tx.producedUtxoIds ?? tx.change.map(utxoId),
}

/** Whether a pending tx can no longer be accepted at `nowMs`. Pure, so the rule is testable. */
export const isPendingTxExpired = (tx: PendingTx, nowMs: number, maxAgeMs: number): boolean =>
  tx.expiresAt === undefined ? nowMs - tx.submittedAt > maxAgeMs : nowMs > tx.expiresAt

const toPersisted = (tx: PendingTx): PersistedPendingTx => ({
  txHash: tx.txHash,
  consumedUtxoIds: tx.consumedUtxoIds,
  producedUtxoIds: tx.producedUtxoIds ?? tx.change.map(utxoId),
  submittedAt: tx.submittedAt,
  ...(tx.expiresAt === undefined ? {} : {expiresAt: tx.expiresAt}),
})

export const createPendingTxTracker = (persistence?: PendingTxPersistence): Effect.Effect<PendingTxTracker> =>
  Effect.gen(function* () {
    const restored = persistence === undefined ? [] : yield* persistence.load()
    const state = yield* Ref.make<ReadonlyMap<string, PendingTx>>(
      new Map(
        restored.map((row) => [
          row.txHash.toLowerCase(),
          {...row, txHash: row.txHash.toLowerCase(), change: [] as readonly UTxO.UTxO[]},
        ]),
      ),
    )

    /** Mirror the map to disk. Best-effort: a failed write must not fail the submit it followed. */
    const persist = Effect.suspend(() =>
      persistence === undefined
        ? Effect.void
        : Effect.flatMap(Ref.get(state), (map) => Effect.ignore(persistence.save([...map.values()].map(toPersisted)))),
    )

    const pending = Effect.map(Ref.get(state), (map) => [...map.values()])

    const lockedUtxoIds = Effect.map(Ref.get(state), (map) => lockedUtxoIdsOf(map.values()))

    const virtualUtxos = Effect.map(Ref.get(state), (map) => unconsumedChangeOf(map.values()))

    const register = (tx: PendingTx) =>
      Effect.flatMap(
        Ref.update(state, (map) => {
          const next = new Map(map)
          next.set(tx.txHash.toLowerCase(), {...tx, txHash: tx.txHash.toLowerCase()})
          return next
        }),
        () => persist,
      )

    const confirm = (txHash: string) =>
      Effect.tap(
        Ref.modify(state, (map) => {
          const key = txHash.toLowerCase()
          if (!map.has(key)) return [false, map] as const
          const next = new Map(map)
          next.delete(key)
          return [true, next] as const
        }),
        () => persist,
      )

    const removeCascading = (map: ReadonlyMap<string, PendingTx>, roots: readonly string[]) => {
      const {removedKeys, kept} = cascadeRemove([...map.values()], CASCADE_SPEC, roots)
      return [removedKeys, new Map(kept.map((tx) => [tx.txHash, tx]))] as const
    }

    const rollback = (txHash: string) =>
      Effect.tap(
        Ref.modify(state, (map) => removeCascading(map, [txHash.toLowerCase()])),
        () => persist,
      )

    const sweep = (nowMs: number, maxAgeMs: number = DEFAULT_PENDING_TIMEOUT_MS) =>
      Effect.tap(
        Ref.modify(state, (map) => {
          const stale = [...map.values()].filter((tx) => isPendingTxExpired(tx, nowMs, maxAgeMs)).map((tx) => tx.txHash)
          return removeCascading(map, stale)
        }),
        () => persist,
      )

    const spendableView = (confirmed: readonly UTxO.UTxO[]) =>
      Effect.map(Ref.get(state), (map) => projectSpendable(confirmed, map.values()))

    return {register, confirm, rollback, pending, lockedUtxoIds, virtualUtxos, spendableView, sweep}
  })
