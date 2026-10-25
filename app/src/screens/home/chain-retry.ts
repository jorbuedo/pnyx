/**
 * Whether a circle's chain badge is also its retry affordance.
 *
 * A deploy that failed can be retried into existence: everything it needs is derived from the
 * content-plane circle id, so a second attempt rebuilds the identical transaction at the identical
 * address (`services/pnyx-proving.ts` → `submitDeviceCircle`).
 *
 * ⚠️ **Founder-only, and not because a service says so.** The address is a hash over `founderAuth`,
 * derived from the *tapping* user's own `forumRoot`. A non-founder retry would deploy a second,
 * unrelated contract and point this circle's row at it — so this is a correctness gate, not a
 * permission one, and it cannot be relaxed to "any moderator".
 *
 * @module
 */

export type ChainRetryInput = {
  /** The viewer's persona is the circle's author. */
  readonly isFounder: boolean
  /** The circle's settlement status; absent means chain mirroring never ran. */
  readonly status?: 'pending' | 'confirmed' | 'failed' | undefined
  /** Whether the session can derive a persona — the enclave unlock supplies it. */
  readonly hasForumRoot: boolean
  /** A retry already in flight, so the badge must not queue a second one. */
  readonly isRetrying: boolean
}

export const canRetryCircleDeploy = ({isFounder, status, hasForumRoot, isRetrying}: ChainRetryInput): boolean =>
  isFounder && status === 'failed' && hasForumRoot && !isRetrying
