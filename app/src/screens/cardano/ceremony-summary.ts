/**
 * The aggregate of a multi-transaction ceremony — what the whole batch does to the
 * wallet, for the summary step that carries the confirm.
 *
 * **Deliberately NOT a synthetic `ReviewedTransaction`.** Reusing that type would
 * render for free, but `hash`, `cbor`, `status` and `fee` have no honest meaning
 * for an aggregate, and the moment such an object exists something downstream will
 * treat it as a real transaction — the submit gate and the leaked-key check both
 * take a `ReviewedTransaction` and assume it corresponds to actual bytes. So this
 * is its own type; the UI reuses the *presentation* pieces (party rows, asset
 * lines, the operations list), never the IR.
 *
 * Pure. Every rule below is a decision worth testing on its own.
 *
 * @module
 */

import type {ReviewedAmount, ReviewedTransaction} from '@pnyx/tx-review'
import {addAmount, COIN, emptyValue, splitNet, toAmounts} from '@pnyx/tx-review'

/** What a ceremony of N transactions does to the wallet, in total. */
export type CeremonySummary = {
  /** How many transactions the confirm authorises. */
  readonly legCount: number
  /**
   * Net effect on the signing wallet across every leg, split for display.
   *
   * Summed, which is self-correcting for a chain: leg A's change is an own
   * *output* in A and an own *input* in B, so the intermediate cancels and what
   * remains is the true net. That is what makes this figure trustworthy on
   * exactly the flows it exists for, rather than merely convenient.
   */
  readonly sent: readonly ReviewedAmount[]
  readonly received: readonly ReviewedAmount[]
  /** Sum of every leg's fee. Kept separate because `ownDelta` excludes fee. */
  readonly totalFee: bigint
  /** Every leg's deposits, summed (stake registration and friends). */
  readonly totalDeposit: bigint
  /**
   * Counterparties across the batch, merged by address so one recipient paid by
   * two legs appears once, with its amounts combined.
   */
  readonly counterparties: readonly {
    readonly addressKey: string
    readonly bech32?: string
    readonly received: readonly ReviewedAmount[]
  }[]
  /**
   * Every leg's operations, **concatenated, never merged** — a stake registration
   * in leg 1 and a delegation in leg 2 are two things that happen, not one.
   */
  readonly operations: readonly ReviewedTransaction['operations'][number][]
  /**
   * The union of every leg's warnings, deduped. Surfaced on the summary because
   * that is where the confirm is: a warning that lives only on leg 2's step lets
   * the user authorise the batch from a screen showing no alarm.
   */
  readonly warnings: readonly ReviewedTransaction['warnings'][number][]
}

/** Sum a leg's own deposits — mirrors `totalDeposit` in `review-model`. */
const depositOf = (reviewed: ReviewedTransaction): bigint => {
  let total = 0n
  for (const op of reviewed.operations) {
    if ('deposit' in op && typeof op.deposit === 'bigint') total += op.deposit
  }
  return total
}

/**
 * Aggregate a ceremony's legs, in order.
 *
 * `legs` must be the transactions the confirm will authorise, and nothing else —
 * the counts and totals here are what the user is consenting to.
 */
export const summarizeCeremony = (legs: readonly ReviewedTransaction[]): CeremonySummary => {
  const net = emptyValue()
  let totalFee = 0n
  let totalDeposit = 0n
  const operations: ReviewedTransaction['operations'][number][] = []
  const warnings = new Set<ReviewedTransaction['warnings'][number]>()
  // Insertion-ordered so counterparties read in first-appearance order, like a
  // single review's own party list.
  const parties = new Map<string, {bech32?: string; value: ReturnType<typeof emptyValue>}>()

  for (const leg of legs) {
    for (const amount of leg.ownDelta) addAmount(net, amount.assetId ?? COIN, amount.quantity)
    totalFee += leg.fee
    totalDeposit += depositOf(leg)
    operations.push(...leg.operations)
    for (const w of leg.warnings) warnings.add(w)
    for (const party of leg.otherGroup.parties) {
      for (const address of party.addresses) {
        const existing = parties.get(address.hex) ?? {
          ...(address.bech32 !== undefined ? {bech32: address.bech32} : {}),
          value: emptyValue(),
        }
        for (const amount of party.received) addAmount(existing.value, amount.assetId ?? COIN, amount.quantity)
        parties.set(address.hex, existing)
      }
    }
  }

  const {sent, received} = splitNet(net)
  return {
    legCount: legs.length,
    sent,
    received,
    totalFee,
    totalDeposit,
    counterparties: [...parties.entries()]
      .map(([addressKey, party]) => ({
        addressKey,
        ...(party.bech32 !== undefined ? {bech32: party.bech32} : {}),
        received: toAmounts(party.value),
      }))
      .filter((p) => p.received.length > 0),
    operations,
    warnings: [...warnings],
  }
}
