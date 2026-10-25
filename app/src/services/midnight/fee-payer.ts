/**
 * Who pays a Midnight transaction's fee, as a pure decision.
 *
 * Every Midnight send from this app has been the sponsor's to pay. The device can now pay for itself —
 * it holds DUST, spends it, proves the spend and seals the transaction — so there is a choice to make,
 * and this is where it is made rather than inside a send.
 *
 **`prefer-self` is the default.** It is the only mode that is strictly better for privacy and never
 * fails: paying our own fee tells the sponsor nothing about what we sent, and falling back keeps the
 * send working when the DUST rail cannot. Sponsor-only remains available as a mode, not as the floor.
 *
 * ## The rule
 *
 * | mode | priced and affordable | priced and short, or a state nothing can spend | **not priced yet** |
 * |---|---|---|---|
 * | `sponsor` | `sponsor` | `sponsor` | `sponsor` |
 * | `self` | `self`, with the fee | `refuse`, naming what is missing | `self`, fee unknown |
 * | `prefer-self` | `self`, with the fee | `sponsor`, **saying why** | `self`, fee unknown |
 *
 * ## Why "not priced yet" is a decision and not a refusal
 *
 * A self-funded fee is only known **after** the transaction is built, because the dust action that
 * pays it changes the size that sets it. So the send screen can never present a priced estimate, and a
 * rule that required one made `prefer-self` fall back every single time — a mode that could not
 * reach its own happy path. What the caller *can* establish first is that a synced, recent state
 * holds some DUST; the exact sufficiency is the builder's to check, and it refuses loudly.
 *
 * ⚠️ That is safe only because building and sending are separate calls
 * (`./send-self-funded.ts`): an unaffordable fee fails at the build, before anything is on chain, so
 * `prefer-self` can still fall back. A caller that submits first and asks later must not use this.
 *
 * ⚠️ **`self` refuses rather than falling back.** A caller that asked to pay its own way and was
 * silently sponsored has had its request answered by a different party — which is exactly the
 * substitution the connector's `payFees: false` refusal exists to prevent.
 *
 * @module
 */

import type {MidnightFeePayer} from '@pnyx/tx-review'

import type {DustStaleness} from './dust-staleness'

/** Who should pay. A setting eventually; {@link DEFAULT_FEE_MODE} is what the app does today. */
export type FeeMode = 'sponsor' | 'self' | 'prefer-self'

/**
 * What a send does when nobody has chosen.
 *
 * `prefer-self` rather than `sponsor`: it is better for privacy on every send that can afford itself,
 * and it degrades to exactly the old behaviour on every send that cannot.
 */
export const DEFAULT_FEE_MODE: FeeMode = 'prefer-self'

export type DustReadiness = {
  /** Spendable DUST at the instant asked about, or `null` when no state has been synced. */
  readonly balance: bigint | null
  /**
   * Whether a re-sync would find anything — `services/midnight/dust-staleness.ts`.
   *
   * ⚠️ **Not an age.** This used to be a fifteen-minute freshness flag, which was wrong in both
   * directions: a state synced hours ago is perfectly spendable if nothing has moved since, and one
   * synced a minute ago is not if this wallet spent in between. Only `current` is safe to take an
   * output from; `activity` means the chain moved and an output may already be consumed, and
   * `unknown` means we cannot tell, which is not the same as fine.
   */
  readonly staleness: DustStaleness
  /**
   * The fee this transaction is expected to cost, or `null` when it has not been priced yet.
   *
   * ⚠️ `null` means **unknown**, not zero and not unaffordable — see the module's third column. For a
   * self-funded send it is normally `null`, because the fee is a function of the built transaction.
   */
  readonly estimatedFee: bigint | null
  /**
   * The ledger block time the stored DUST state's roots belong to, or `null` when none was recorded.
   *
   * ⚠️ **This is the condition that decides self-funding, and `null` and `0` both mean "cannot".** A
   * DUST spend declares this as its `ctime` and the node looks the roots up under it
   * (`root_history.get(ctime)`), so a state belonging to no instant produces a proof the node refuses
   * — reported as `InvalidDustSpendProof`. Only the event replay sets it; the fast sync never does,
   * which is why a *fully current* wallet can still be unable to pay. `docs/DUST_SPEND_PROOF.md`.
   */
  readonly blockTimeSecs: number | null
}

export type FeeDecision =
  | {
      readonly kind: 'pay'
      readonly payer: MidnightFeePayer
      /**
       * Why the sponsor is paying when the mode asked this wallet to pay for itself.
       *
       * ⚠️ **Absent is not "no reason" — it means nothing was substituted.** `prefer-self` used to
       * return a bare sponsor payer and drop the answer `cannotSelfFund` had just computed, so the
       * review changed from "From your DUST" to "Paid for you" with nothing said and nothing logged.
       * Two lines below, the `refuse` branch says "saying why beats a silent sponsor substitution — that
       * is the whole distinction the mode encodes"; this is what makes that true of `prefer-self` too.
       */
      readonly substitutedBecause?: string
    }
  /** Cannot proceed as asked. `reason` is caller-facing and names what is missing. */
  | {readonly kind: 'refuse'; readonly reason: string}

/**
 * Why this wallet cannot pay for itself right now, or `null` when it can.
 *
 * Split out so both `self` and `prefer-self` ask the same question and cannot drift on the answer.
 */
const cannotSelfFund = (dust: DustReadiness): string | null => {
  if (dust.balance === null) {
    // Not "no DUST" — nobody has looked. The two justify different messages and different fixes.
    return 'this wallet has not synced its DUST yet'
  }
  if (dust.blockTimeSecs === null || dust.blockTimeSecs === 0) {
    // Asked before staleness and before the figures on purpose: this is the condition that actually
    // decides the outcome, so any reason ordered ahead of it would send the user to a refresh that
    // cannot restore self-funding — which is what made the review promise "From your DUST" and then
    // silently substitute the sponsor.
    return (
      'this wallet’s DUST state belongs to no block time, so the node cannot check a spend from it — ' +
      'only an event replay sets one, and refreshing does not'
    )
  }
  if (dust.staleness === 'activity') {
    return 'this wallet has moved since its DUST was synced, so an output it holds may already be spent'
  }
  if (dust.staleness !== 'current') {
    // `never` (nothing synced) is caught by the balance check above; `unknown` reaches here, and
    // "we cannot tell" must not read as "fine" when the cost of being wrong is a rejected spend.
    return 'this wallet’s DUST state cannot be checked against the chain'
  }
  if (dust.balance === 0n) {
    return 'this wallet holds no DUST yet'
  }
  if (dust.estimatedFee === null) {
    // Unknown, not unaffordable. The builder prices it exactly and refuses if the state is short, and
    // that happens before anything is submitted — so letting it through here costs a failed build at
    // worst, while blocking here costs the mode its entire purpose.
    return null
  }
  if (dust.balance < dust.estimatedFee) {
    return `this wallet holds ${dust.balance} SPECK of DUST and the fee is ${dust.estimatedFee}`
  }
  return null
}

/** Who pays, given the mode and what the DUST rail can currently do. */
export const decideFeePayer = (mode: FeeMode, dust: DustReadiness): FeeDecision => {
  if (mode === 'sponsor') return {kind: 'pay', payer: {by: 'sponsor'}}

  const blocked = cannotSelfFund(dust)
  if (blocked === null) {
    // `null` when unpriced, and it stays `null`: a review that showed `0` would be quoting a price
    // nobody computed. The builder fills it in, and the caller reports the figure it actually paid.
    return {kind: 'pay', payer: {by: 'self', dust: dust.estimatedFee}}
  }
  if (mode === 'prefer-self') return {kind: 'pay', payer: {by: 'sponsor'}, substitutedBecause: blocked}
  return {kind: 'refuse', reason: blocked}
}
