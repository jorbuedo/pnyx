/**
 * How many key packages one identity may take from another's pool.
 *
 * ⚠️ **A bound on draining, not a consent gate, and the difference matters.** Claiming is still
 * open to anyone: this only stops a single actor emptying a pool, which is what left the owner
 * unreachable — every legitimate peer got `409 no key packages available` until that device
 * refilled (`docs/ABUSE_MITIGATION.md` §5, D3, verified 3 of 3). Identity is free (§0), so the same
 * drain spread across fresh subjects still works. The fix for *that* is the consent layer, and a
 * lower cap here would only break the honest retry path.
 *
 * @module
 */

/** The knobs, as one value object rather than constants read at each site. */
export type DmClaimPolicy = {
  /** How many claims one identity may take from one pool inside the window. */
  readonly perPeer: number;
  /** How long that window is. */
  readonly windowMs: number;
};

/**
 * The live policy.
 *
 * **Five per peer per day.** One conversation costs one claim, and a person starts one conversation
 * with a given person — so five is the *retry* budget, not the usage budget. A Welcome can fail for
 * reasons that are nobody's fault (a claimed package whose private half went with a reinstall, a
 * dropped response), and each retry costs another claim, so the cap has to sit well above one.
 * Against a pool bounded at 40 (`dm-retention.ts`), five leaves a single identity able to take an
 * eighth of it.
 */
export const DM_CLAIMS: DmClaimPolicy = {
  perPeer: 5,
  windowMs: 24 * 60 * 60 * 1000,
};

/** The start of the window a claim at `nowMs` is counted against, as an ISO-8601 string. */
export const claimWindowStart = (nowMs: number, policy: DmClaimPolicy = DM_CLAIMS): string =>
  new Date(nowMs - policy.windowMs).toISOString();

/**
 * Whether a claimer who has already taken `recentClaims` from this pool inside the window may take
 * another.
 *
 * Pure so the rule is testable without a store: the count comes from the caller.
 */
export const mayClaim = (recentClaims: number, policy: DmClaimPolicy = DM_CLAIMS): boolean =>
  recentClaims < policy.perPeer;
