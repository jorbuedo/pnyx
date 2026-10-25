/**
 * Unshielded Midnight transactions, projected into what an activity row needs.
 *
 * The same subscription that yields the UTxO set carries the transactions that produced it, so activity
 * is a second reading of one stream rather than a second rail.
 *
 * ⚠️ **Shielded transfers are absent, and cannot be added from here.** A shielded coin has no address, so
 * there is no by-address history to subscribe to; the only record of one is what our own wallet applied
 * during sync, and `syncShieldedRange` keeps no per-transaction journal. Rendering an empty Midnight
 * section would say "nothing happened on the shielded rail", which is a claim we cannot make.
 *
 * @module
 */

import {parseValue, type UnshieldedEvent} from './unshielded-utxo-set'

/** A direction is about *our* balance, not about who authored the transaction. */
export type MidnightDirection = 'sent' | 'received' | 'self'

export type MidnightActivity = {
  /** The indexer's transaction id — the subscription's cursor, and a stable sort key. */
  readonly transactionId: number
  readonly hash: string
  /** ISO 8601, or absent when the indexer reported no block time. Absent sorts as pending. */
  readonly timestamp?: string
  readonly blockHeight?: number
  readonly direction: MidnightDirection
  /**
   * Signed atomic totals per token type: positive received, negative spent.
   *
   * A token whose net is **zero is absent**, not zero — which is why participation is a separate
   * field. See {@link MidnightActivity.tokens}.
   */
  readonly netByToken: ReadonlyMap<string, bigint>
  /**
   * Every token type this transaction moved for us, whatever the net came to.
   *
   * Distinct from `netByToken`'s keys because those answer a different question: how the balance
   * *changed*. A self-send's created and spent amounts cancel exactly, so its net is empty — and a
   * per-token activity list that filtered on the net could not see that NIGHT was involved at all.
   * The transaction was stored, classified `self` correctly, and then dropped from the one list that
   * should have shown it.
   */
  readonly tokens: ReadonlySet<string>
  /**
   * The identifiers the chain recorded for this transaction.
   *
   * **How a send is matched to its row.** The device cannot compute a hash for a transfer it built —
   * the ledger gives one only for a *bound* transaction, and binding happens at the sponsor — so the
   * hash here was never knowable before submission. Identifiers were, and the ledger's own
   * `has_identifier` is a containment test, which is why matching asks whether any of a pending send's
   * identifiers appear here rather than comparing sets.
   */
  readonly identifiers: readonly string[]
  /** What the chain did with it, when the indexer said. Absent means it did not report. */
  readonly outcome?: MidnightTxOutcome
  /**
   * Set only on a row synthesised from a send that has not been seen on chain yet.
   *
   * Explicit rather than inferred from an absent `timestamp`: an **indexed** row can also lack a block
   * time, and "the indexer reported no time" is a different fact from "this has not been indexed at
   * all". Only the second may be rendered as in-flight or dropped once the real row arrives.
   */
  readonly pending?: true
  /**
   * How many of **our** unshielded outputs the transaction spent, and how many it gave us back.
   *
   * Ours only, and the naming says so: the subscription is `unshieldedTransactions(address:)` and the
   * indexer scopes both sides to that address, so a payment's output to the recipient never appears
   * here. Verified on a real preprod transfer — the chain shows 2 created outputs (our change and the
   * recipient's), the event carried 1.
   *
   * The data was always in the event; this used to compute `netByToken` from it and drop the rest,
   * which is what left the detail screen claiming Midnight "reports what a transaction moved, not the
   * outputs it selected". For the wallet's own outputs it reports both, which is the half that decides
   * whether the next send fits.
   */
  readonly ourSpentCount: number
  readonly ourCreatedCount: number
  /**
   * The fee, in **SPECK** — the atomic unit of DUST, not NIGHT.
   *
   * The indexer says so itself (`RegularTransaction.fee`: "The fee for this transaction in SPECK
   * (atomic unit of DUST)"), and it follows from the chain: Midnight fees are DUST-only. This was
   * documented as "atomic NIGHT" and rendered as NIGHT, which is the wrong token at 10⁹ times the
   * wrong scale — DUST carries 15 decimals (`DUST_DECIMALS`), NIGHT 6.
   */
  readonly fee?: bigint
  /** Addresses on the other side — outputs that are not ours. Empty for a self-transfer. */
  readonly counterparties: readonly string[]
}

export type IndexedTransactionRef = {
  readonly id?: number
  readonly hash?: string
  readonly fee?: string | null
  readonly block?: {readonly height?: number; readonly timestamp?: number} | null
  readonly identifiers?: readonly string[] | null
  readonly transactionResult?: {
    readonly status?: string
    readonly segments?: readonly {readonly id?: number; readonly success?: boolean}[] | null
  } | null
}

/** What the chain did with a transaction, per segment. `SUCCESS | PARTIAL_SUCCESS | FAILURE`. */
export type MidnightTxOutcome = {
  readonly status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'
  /**
   * Per-segment truth, when the indexer reports it.
   *
   * Empty on a full success — the indexer sends no per-segment detail when none of it failed — so an
   * empty list must not be read as "no segments ran".
   */
  readonly segments: readonly {readonly id: number; readonly success: boolean}[]
}

const OUTCOME_STATUSES = new Set(['SUCCESS', 'PARTIAL_SUCCESS', 'FAILURE'])

/**
 * Whether this row is the transaction a pending send became.
 *
 * **Containment, not equality**, and the asymmetry is the point: the sponsor merges its balancing into
 * the transaction it was handed, so what lands carries the device's identifiers *plus* its own. The
 * ledger models the same test as `has_identifier`. Comparing sets would never match, and comparing
 * hashes cannot even be attempted — the device has no hash for an unbound transaction.
 *
 * An empty `pending` never matches: a send whose identifiers were not recorded is untrackable, and
 * "matches everything" would attach it to the first row to arrive.
 */
export const isSameTransaction = (row: MidnightActivity, pending: readonly string[]): boolean => {
  if (pending.length === 0) return false
  const landed = new Set(row.identifiers.map((id) => id.toLowerCase()))
  return pending.some((id) => landed.has(id.toLowerCase()))
}

/**
 * Read the indexer's transaction result, or `undefined` when it reported none.
 *
 * An unrecognised status is dropped rather than coerced: a future status read as one of these three
 * would state an outcome the chain never gave.
 */
export const outcomeOf = (result: IndexedTransactionRef['transactionResult']): MidnightTxOutcome | undefined => {
  const status = result?.status
  if (status === undefined || !OUTCOME_STATUSES.has(status)) return undefined
  const segments = (result?.segments ?? []).flatMap((segment) =>
    segment.id === undefined || segment.success === undefined ? [] : [{id: segment.id, success: segment.success}],
  )
  return {status: status as MidnightTxOutcome['status'], segments}
}

/**
 * The indexer types `Block.timestamp` as `Int` but answers in **milliseconds**, which does not fit a
 * 32-bit int — so both units are possible across server versions and the value has to be read, not
 * assumed. Anything at or above 1e12 is already milliseconds; below that it can only be seconds, since a
 * millisecond timestamp that small would be 1970.
 *
 * `undefined` for a missing or non-finite value: an absent time is rendered as pending, while a time
 * guessed wrong by a factor of 1000 would date every row to 1970 or to the year 58000.
 */
export const normalizeBlockTimestamp = (raw: number | null | undefined): string | undefined => {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined
  const ms = raw >= 1e12 ? raw : raw * 1000
  const iso = new Date(ms).toISOString()
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

const signedNet = (event: UnshieldedEvent, address: string): ReadonlyMap<string, bigint> => {
  const net = new Map<string, bigint>()
  const add = (tokenType: string, delta: bigint) => {
    const next = (net.get(tokenType) ?? 0n) + delta
    if (next === 0n) net.delete(tokenType)
    else net.set(tokenType, next)
  }
  for (const utxo of event.createdUtxos ?? []) {
    if (utxo.owner !== address) continue
    const value = parseValue(utxo.value)
    if (value !== null) add(utxo.tokenType.toLowerCase(), value)
  }
  for (const utxo of event.spentUtxos ?? []) {
    if (utxo.owner !== address) continue
    const value = parseValue(utxo.value)
    if (value !== null) add(utxo.tokenType.toLowerCase(), -value)
  }
  return net
}

/**
 * Direction from the net effect on our balance.
 *
 * A transaction that spends ours and pays only ourselves nets to nothing but is not "no activity" — it is
 * a self-transfer, which is why an all-zero net with a spend of ours reads as `self` rather than
 * `received`.
 */
const directionOf = (net: ReadonlyMap<string, bigint>, spentAny: boolean): MidnightDirection => {
  let positive = false
  let negative = false
  for (const value of net.values()) {
    if (value > 0n) positive = true
    if (value < 0n) negative = true
  }
  if (negative) return 'sent'
  if (positive) return 'received'
  return spentAny ? 'self' : 'received'
}

/**
 * Project one subscription event. `null` when the event touches nothing of ours — the subscription is
 * address-scoped, but a transaction can appear for a spend we do not own once other filters change.
 */
export const midnightActivityOf = (
  event: UnshieldedEvent & {readonly transaction?: IndexedTransactionRef | null},
  address: string,
): MidnightActivity | null => {
  const tx = event.transaction
  const id = tx?.id
  const hash = tx?.hash
  if (id === undefined || hash === undefined) return null

  const ours = (utxo: {readonly owner: string}) => utxo.owner === address
  const touchesUs = (event.createdUtxos ?? []).some(ours) || (event.spentUtxos ?? []).some(ours)
  if (!touchesUs) return null

  const net = signedNet(event, address)
  const tokens = new Set<string>()
  for (const utxo of [...(event.createdUtxos ?? []), ...(event.spentUtxos ?? [])]) {
    if (utxo.owner === address) tokens.add(utxo.tokenType.toLowerCase())
  }
  const spentAny = (event.spentUtxos ?? []).some(ours)
  const timestamp = normalizeBlockTimestamp(tx?.block?.timestamp)
  const fee = tx?.fee === null || tx?.fee === undefined ? null : parseValue(tx.fee)
  const counterparties = [
    ...new Set((event.createdUtxos ?? []).filter((utxo) => utxo.owner !== address).map((utxo) => utxo.owner)),
  ]

  const outcome = outcomeOf(tx?.transactionResult)
  return {
    transactionId: id,
    hash,
    identifiers: tx?.identifiers ?? [],
    ...(outcome === undefined ? {} : {outcome}),
    ...(timestamp === undefined ? {} : {timestamp}),
    ...(tx?.block?.height === undefined ? {} : {blockHeight: tx.block.height}),
    direction: directionOf(net, spentAny),
    netByToken: net,
    tokens,
    ourSpentCount: (event.spentUtxos ?? []).filter(ours).length,
    ourCreatedCount: (event.createdUtxos ?? []).filter(ours).length,
    ...(fee === null ? {} : {fee}),
    counterparties,
  }
}

/**
 * Collapse rows that belong to the same transaction into one.
 *
 * ⚠️ **The subscription yields one event per transaction *per relevant part*, not one per
 * transaction.** A sponsored transaction carries two intents — the payer's and the fee's — and an
 * address-scoped feed can report our involvement in more than one of them. Surfaced by a faucet payout
 * on preprod: 1000 NIGHT arrived and the activity list showed the transfer twice, with React also
 * complaining that two children shared a key. The duplicate key was the symptom; the defect was the
 * same transaction listed twice.
 *
 * Merging is not the same as de-duplicating. Each event carries only *its* part of what moved, so a
 * naive "keep the first" would under-report the amount. The nets and the counts are summed, the token
 * sets and counterparties unioned, and the direction is then re-derived from the merged net — because
 * two halves that individually look like a spend and a receive are together a self-send.
 *
 * Keyed by hash rather than by identifier: identifiers are per-intent, so the two rows of one
 * transaction legitimately carry different ones, and the hash is what they share.
 *
 * ⚠️ Pending rows are **never** merged into an indexed one. A pending row is a local synthesis with no
 * block behind it, and folding it in would make an unconfirmed send look confirmed.
 */
export const mergeActivityByTransaction = (rows: readonly MidnightActivity[]): readonly MidnightActivity[] => {
  const merged = new Map<string, MidnightActivity>()
  const out: MidnightActivity[] = []

  for (const row of rows) {
    if (row.pending === true) {
      // Kept as its own row: it has no chain identity to merge on.
      out.push(row)
      continue
    }
    const seen = merged.get(row.hash)
    if (seen === undefined) {
      merged.set(row.hash, row)
      continue
    }

    const netByToken = new Map(seen.netByToken)
    for (const [token, delta] of row.netByToken) {
      const total = (netByToken.get(token) ?? 0n) + delta
      // A token that nets to zero across the parts is absent, not zero — the same rule a single
      // event's projection follows, so a merged self-send looks like one.
      if (total === 0n) netByToken.delete(token)
      else netByToken.set(token, total)
    }
    const spent = seen.ourSpentCount + row.ourSpentCount
    const combined: MidnightActivity = {
      ...seen,
      // The lowest id is the transaction's own place in the feed; a later part must not move it.
      transactionId: Math.min(seen.transactionId, row.transactionId),
      netByToken,
      tokens: new Set([...seen.tokens, ...row.tokens]),
      identifiers: [...new Set([...seen.identifiers, ...row.identifiers])],
      ourSpentCount: spent,
      ourCreatedCount: seen.ourCreatedCount + row.ourCreatedCount,
      counterparties: [...new Set([...seen.counterparties, ...row.counterparties])],
      direction: directionOf(netByToken, spent > 0),
      // Either part may be the one the indexer priced or timed; keep whichever we have.
      ...(seen.timestamp === undefined && row.timestamp !== undefined ? {timestamp: row.timestamp} : {}),
      ...(seen.blockHeight === undefined && row.blockHeight !== undefined ? {blockHeight: row.blockHeight} : {}),
      ...(seen.outcome === undefined && row.outcome !== undefined ? {outcome: row.outcome} : {}),
      // The fee belongs to the transaction, so it is taken once rather than added — the same figure
      // arriving on both parts would otherwise double it.
      ...(seen.fee === undefined && row.fee !== undefined ? {fee: row.fee} : {}),
    }
    merged.set(row.hash, combined)
  }

  return [...out, ...merged.values()]
}
