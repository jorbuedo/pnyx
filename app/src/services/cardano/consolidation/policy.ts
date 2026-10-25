/**
 * Wallet-optimization policy: the knobs that tell the builder *how* to shape a
 * wallet's UTxO set, as opposed to what to send.
 *
 * These are user preferences, not protocol facts. The protocol bounds
 * (`maxTxSize`, `maxValueSize`, min-ADA) are computed by the library and are not
 * negotiable; everything here is a choice about how to live within them, and
 * every one of them costs something — usually a fee, sometimes locked ADA.
 *
 * Kept separate from the planner so the settings screen and the planner share one
 * definition, and so the defaults are stated in exactly one place.
 *
 * @module
 */

/** How aggressively the wallet reshapes its own UTxO set. */
export type WalletOptimization = {
  /**
   * Consolidate automatically when a send would otherwise not fit in one
   * transaction. Off means the send fails with an actionable error and the user
   * consolidates deliberately.
   *
   * Costs an extra transaction's fee, and makes the send non-atomic: the
   * consolidation must land before the send it enables.
   */
  readonly autoConsolidate: boolean
  /**
   * Fold available staking rewards into a build when withdrawing them would help.
   * A withdrawal adds ADA without adding an input, so it can pay for a send that
   * coin selection could not otherwise afford — and it costs nothing extra
   * beyond the certificate's bytes.
   */
  readonly autoWithdrawRewards: boolean
  /**
   * Group assets sharing a policy into the same output.
   *
   * A `Value` groups assets under their policy id, so co-locating them is
   * markedly denser than spreading them — fewer outputs, and therefore less ADA
   * locked in min-ADA. Off preserves the existing per-UTxO grouping.
   */
  readonly bundleByPolicy: boolean
  /**
   * Always leave at least one pure-ADA output.
   *
   * A token-free UTxO is the cheapest possible input for the next transaction:
   * no asset bytes, min-ADA at the floor. Without one, every later send must
   * drag a token bundle through its inputs and change.
   */
  readonly keepPureAdaOutput: boolean
  /**
   * Hard cap on inputs per transaction, below whatever the size bound would
   * allow. `undefined` means the size bound alone decides.
   *
   * A cap is a blunt instrument — the size bound is exact and measured — but it
   * bounds *signing* time too, which matters on a hardware wallet where every
   * input is a device round-trip.
   */
  readonly maxInputsPerTx?: number
}

/**
 * Conservative defaults: nothing that costs a fee happens without being asked.
 *
 * `bundleByPolicy` and `keepPureAdaOutput` are on because they only shape
 * transactions the user already asked for — they add no transaction of their own.
 * `autoConsolidate` is off because it does.
 */
export const DEFAULT_WALLET_OPTIMIZATION: WalletOptimization = {
  autoConsolidate: false,
  autoWithdrawRewards: false,
  bundleByPolicy: true,
  keepPureAdaOutput: true,
}
