/**
 * Which block range one shielded refresh should walk, and whether the tree must be fast-forwarded
 * first.
 *
 * Its own module because every rule here is a decision rather than an effect, and because importing the
 * sync itself pulls `@pnyx/midnight-native` — and therefore `expo-modules-core` — into a test runner that
 * has no Expo global.
 *
 * @module
 */

/** Where a first sync starts, and how much that start is worth believing. */
export type ShieldedBirthday = {
  readonly height: number
  /**
   * Where the number came from, which is also how much it is worth believing.
   *
   * - `created` — this app generated the seed at this height, so no coin can predate it and a scan
   *   from here is **complete**.
   * - `recovered` — the same number, carried across a device loss in the recovery blob; same
   *   guarantee.
   * - `declared` — **the user said so** (plan item 62(c)), for a wallet that predates birthdays or a
   *   seed brought in from elsewhere. Usually resolved from the date the wallet was added here, which
   *   is only an upper bound for an imported seed — so the completeness is theirs to claim, not ours.
   *
   * ⚠️ **There is deliberately no value for a guess of ours.** A wallet with no record has no birthday,
   * which is `undefined`, because a number the app invented would be rendered to its owner as a
   * complete history. `declared` is not that: it is a statement the person made, and the screen that
   * takes it says what it costs if they are wrong.
   */
  readonly origin: 'created' | 'recovered' | 'declared'
}

export type SyncPlan = {
  readonly fromHeight: number
  readonly toHeight: number
  /**
   * True when the local tree holds nothing before `fromHeight` — a first sync.
   *
   * ⚠️ **Not cosmetic.** The commitment tree is indexed by position, so a wallet that applies its
   * first transaction to a blank tree puts the coin at index 0 and every spend it proves is against a
   * root no block ever held. The caller must fast-forward across the leaves before `fromHeight` with
   * the indexer's collapsed update before applying anything.
   */
  readonly collapseFirst: boolean
}

/**
 * `null` means nothing to do.
 *
 * Four rules, each with a cost behind it:
 *
 * - **A first sync starts at the wallet's birthday.** That is the height the seed was created at, so
 *   nothing it can hold is older. Recorded at creation and carried in the recovery blob (plan item
 *   61(a)); a wallet from before that feature, or a seed imported from elsewhere, has none.
 * - **With no birthday, a first sync starts near the tip.** A phone walking a whole chain is not a
 *   sync, it is a hang. ⚠️ The consequence has to be stated wherever a balance from such a wallet is
 *   shown: it is what this device could see, not what the seed holds.
 * - **A later sync resumes at `cursor + 1`.** The tree is indexed by position, so applying a block
 *   twice puts our coins at indices the chain gave to other commitments.
 * - **A cursor at or beyond the tip does nothing.** Beyond happens after a rollback or an indexer
 *   switch; a backwards range would rescan blocks the state already holds.
 */
export const syncWindow = (params: {
  readonly tip: number
  readonly cursor: number | undefined
  readonly window: number
  readonly birthday?: ShieldedBirthday | undefined
}): SyncPlan | null => {
  const {tip, cursor, window, birthday} = params
  const firstSync = cursor === undefined
  const fromHeight = firstSync ? Math.max(1, birthday === undefined ? tip - window + 1 : birthday.height) : cursor + 1
  if (fromHeight > tip) return null
  return {fromHeight, toHeight: Math.min(tip, fromHeight + window - 1), collapseFirst: firstSync}
}
