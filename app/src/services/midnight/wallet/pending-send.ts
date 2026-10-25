/**
 * What the wallet knows about a send it has handed over but not yet seen land.
 *
 * ⚠️ **This exists because a send is otherwise untrackable.** The sponsor balances and submits, and the
 * app is told only that the bytes were accepted (`Sent for submission`). It cannot poll by hash: the
 * ledger gives a hash only for a *bound* transaction and binding happens at the sponsor, so the device
 * never had one. What it does have is the transaction's identifiers, which survive the sponsor merging
 * its balancing in — so those are what a pending send records and what the arriving rows are matched
 * against.
 *
 * The resolution rule is pure and lives here, separate from the storage in `pending-send-store.ts`, so
 * it can be tested without a device.
 *
 * @module
 */

import {isSameTransaction, type MidnightActivity} from './midnight-activity'

/** A send handed to the sponsor, still waiting to be seen on chain. */
export type PendingSend = {
  /**
   * The identifiers the device read off the transaction it built.
   *
   * Never empty — a send whose identifiers could not be read is not recorded as pending at all, since
   * an empty set matches nothing and would sit here for ever.
   */
  readonly identifiers: readonly string[]
  readonly rail: 'unshielded' | 'shielded'
  /**
   * How the row should read, decided at submission from the same `sending-to-self` note the review
   * screen renders.
   *
   * Not inferred here. A self-send is only recognisable against the wallet's own addresses, which this
   * module does not have — and guessing `'sent'` mislabelled every self-send for its whole pending
   * window, then visibly relabelled it to "Internal" the moment it landed.
   */
  readonly direction: 'sent' | 'self'
  readonly tokenType: string
  readonly amount: bigint
  /** Where it was sent, for rendering the row before the chain describes it. */
  readonly recipient: string
  /** ISO 8601, when the sponsor accepted the bytes. */
  readonly submittedAt: string
}

/** A pending send that has been seen on chain, paired with the row that is it. */
export type ResolvedSend = {
  readonly send: PendingSend
  readonly row: MidnightActivity
}

export type PendingSendResolution = {
  /** Sends now accounted for on chain. The caller drops these and reports their outcome. */
  readonly resolved: readonly ResolvedSend[]
  /** Sends still unseen, in their original order. */
  readonly stillPending: readonly PendingSend[]
  /**
   * Sends old enough that waiting longer says nothing.
   *
   * Distinguished from `stillPending` because they mean different things to a user: one is "in
   * flight", the other is "this never arrived, and nothing will tell you why". A node-level rejection
   * (a bad fee, an expired TTL) leaves no trace on chain at all, so the *absence* of a row past the
   * transaction's own lifetime is the only signal that exists.
   */
  readonly abandoned: readonly PendingSend[]
}

/**
 * A transfer's TTL is an hour (`TTL_SECONDS` in `send.ts`), after which the node will not accept it.
 * Twice that is comfortably past any reordering or indexer lag, and a send unseen by then is not
 * coming.
 */
export const PENDING_SEND_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Match pending sends against the rows a sync produced.
 *
 * Matching is **containment** (see {@link isSameTransaction}): the landed transaction carries the
 * device's identifiers plus the sponsor's, so equality would never hold.
 *
 * `now` is passed in rather than read so the rule is deterministic in tests.
 */
export const resolvePendingSends = (
  pending: readonly PendingSend[],
  rows: readonly MidnightActivity[],
  now: number,
): PendingSendResolution => {
  const resolved: ResolvedSend[] = []
  const stillPending: PendingSend[] = []
  const abandoned: PendingSend[] = []

  for (const send of pending) {
    const row = rows.find((candidate) => isSameTransaction(candidate, send.identifiers))
    if (row !== undefined) {
      resolved.push({send, row})
      continue
    }
    // `Date.parse` of a malformed stamp is NaN, and every comparison against NaN is false — which
    // would keep such a send pending for ever. Treat an unreadable stamp as expired instead: the row
    // cannot be matched and nothing will change that.
    const submitted = Date.parse(send.submittedAt)
    if (Number.isNaN(submitted) || now - submitted > PENDING_SEND_TTL_MS) {
      abandoned.push(send)
      continue
    }
    stillPending.push(send)
  }

  return {resolved, stillPending, abandoned}
}

/**
 * A pending send as the activity list should show it.
 *
 * The row component already renders an in-flight row for a timestamp-less entry — spinner and "Pending"
 * — so this only has to produce the row that never existed. Three fields cannot come from the chain,
 * because the chain has not seen this yet:
 *
 * - **`transactionId`** is `Number.MAX_SAFE_INTEGER`: a **sort and dedup sentinel, not an indexer id**.
 *   Nothing has indexed this transaction, and both uses of the field want the row newest.
 * - **`hash`** carries the send's first identifier. A pre-binding transaction has no hash at all, and
 *   the identifier is the only real handle it has — so this is a genuine value under a badly-fitting
 *   name, not a placeholder.
 * - **`pending: true`** says the row is synthesised, so no reader has to infer it from the missing
 *   timestamp.
 *
 * **The row is shaped like the one that will replace it**, so nothing visibly changes when the chain
 * accounts for it. A send to a stranger nets negative. A **self-send nets nothing** — its created and
 * spent amounts cancel exactly, and `signedNet` drops a zero entry — so it carries no amount at all,
 * exactly as the landed row will. `tokens` records participation either way, which is what a per-token
 * list filters on; without it a self-send would vanish from its own token's history.
 */
export const pendingSendAsActivity = (send: PendingSend): MidnightActivity => ({
  transactionId: Number.MAX_SAFE_INTEGER,
  hash: send.identifiers[0] as string,
  direction: send.direction,
  netByToken: send.direction === 'self' ? new Map() : new Map([[send.tokenType.toLowerCase(), -send.amount]]),
  tokens: new Set([send.tokenType.toLowerCase()]),
  ourSpentCount: 0,
  ourCreatedCount: 0,
  counterparties: [send.recipient],
  identifiers: send.identifiers,
  pending: true,
})

/**
 * Which pending sends the activity list should still show above `rows`, newest first.
 *
 * **The indexed row wins the moment it exists**, matched by containment — so a row never duplicates and
 * a pending entry never has to promote itself into a confirmed one. Mirrors the Cardano overlay rule;
 * the difference is only that Cardano can compare hashes and this cannot.
 */
export const visiblePendingSends = (
  pending: readonly PendingSend[],
  rows: readonly MidnightActivity[],
  now: number,
): readonly MidnightActivity[] =>
  resolvePendingSends(pending, rows, now).stillPending.map(pendingSendAsActivity).reverse()
