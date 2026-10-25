/**
 * Whether this wallet's DUST state is worth re-syncing, as a pure decision.
 *
 * Its own module because it is the half worth testing, and because getting it wrong is silent both
 * ways: too eager and every screen open costs a biometric prompt and forty seconds, too lax and the
 * wallet spends outputs the chain already consumed.
 *
 * ## Why time is the wrong signal on its own
 *
 * A DUST balance is **not** stale merely because it was synced long ago. `spendableDustAt(state, now)`
 * recomputes accrual from the stored state against the current clock on every read, so the *number*
 * keeps growing without any network at all — a wallet synced ten hours ago still shows the right
 * figure. What goes stale is the **UTxO set**: outputs this wallet already spent, and outputs created
 * for NIGHT that arrived since.
 *
 * Both of those accompany a transaction that touches this wallet's unshielded outputs — a self-funded
 * send spends NIGHT, a registration spends NIGHT, and NIGHT arriving is an unshielded output by
 * definition. So the unshielded sync's watermark is the signal, and it is one the app already keeps
 * up to date on every launch at no extra cost.
 *
 * ## Why this decides rather than acts
 *
 * A DUST sync needs the dust **secret** key (`dustApplyGeneration` takes it), so it opens the vault.
 * Doing that on a timer would put an unexplained biometric prompt in front of someone who only opened
 * a screen. The rule below says whether a sync is *warranted*; asking is the caller's job.
 *
 * | state | means |
 * |---|---|
 * | `never` | no DUST state stored — nothing to show and nothing to compare |
 * | `current` | synced, and no unshielded activity since |
 * | `activity` | unshielded outputs changed after the last DUST sync, so the set may be wrong |
 * | `unknown` | synced, but there is no unshielded watermark to compare against |
 *
 * @module
 */

export type DustStaleness = 'never' | 'current' | 'activity' | 'unknown'

export type DustFreshnessInputs = {
  /** Unix seconds of the last successful DUST sync, or `undefined` if it never ran. */
  readonly dustSyncedAt: number | undefined
  /**
   * The unshielded transaction id the DUST state was synced against.
   *
   * `undefined` for a state written before this was recorded — which is not the same as zero. Zero is
   * a real watermark meaning "no unshielded activity had been seen", and treating a missing one as
   * zero would report every such wallet as stale forever.
   */
  readonly dustWatermark: number | undefined
  /** The unshielded transaction id the wallet has now reached, or `undefined` if never synced. */
  readonly unshieldedWatermark: number | undefined
}

/**
 * What to tell the user, and whether a refresh would achieve anything.
 *
 * Note the asymmetry: a *missing* watermark on either side yields `unknown` rather than `activity`.
 * "We cannot tell" and "we know it changed" are different claims, and only the second justifies
 * telling someone their balance may be wrong.
 */
export const dustStaleness = (inputs: DustFreshnessInputs): DustStaleness => {
  if (inputs.dustSyncedAt === undefined) return 'never'
  if (inputs.dustWatermark === undefined || inputs.unshieldedWatermark === undefined) return 'unknown'
  return inputs.unshieldedWatermark > inputs.dustWatermark ? 'activity' : 'current'
}
