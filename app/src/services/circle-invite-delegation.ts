/**
 * Whether a circle has delegated its invite issuance to us — decided from two independent reads.
 *
 * The two are not interchangeable and the whole point of this module is that they are not collapsed:
 *
 * - **the contract's `inviteAuthority` cell** is the *only* source for whether a delegation is live.
 *   A founder who set a rule and never made the call has no delegation; one who withdrew it on chain
 *   has none either, however long ago the service cached something.
 * - **the service's `authorityCommitment`** is what we *would* use if delegated. It says nothing
 *   about the circle. It is one half of a comparison, never an answer on its own.
 *
 * ⚠️ **Four states, not two.** "Nobody has it", "we have it", "somebody else has it" and "we could
 * not tell" all render differently, and the failure mode this exists to prevent is showing "off" for
 * the last one — which invites a founder to redo a delegation that is already live, spending a
 * sponsored transaction to change nothing.
 *
 * @module
 */

/** What the founder's control is looking at. */
export type DelegationState =
  /** The circle has delegated to nobody. The grant control is the honest thing to offer. */
  | 'none'
  /** The circle has delegated to this deployment. Self-service works; revoking is the only change. */
  | 'ours'
  /**
   * Delegated, but to a commitment that is not ours.
   *
   * A real state rather than a defensive branch: `setInviteAuthority` is a rotate as much as a set,
   * so a circle that moved to another attestor — or to a founder-held secret — lands here. Granting
   * from here **replaces** whoever holds it, which is worth saying before the tap rather than after.
   */
  | 'other'
  /** The chain read failed. Not "off": see the module note. */
  | 'unknown'

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * @param onChain the contract's `inviteAuthority`, `undefined` for "delegated to nobody"
 * @param ours the commitment this deployment publishes, `null` when the service did not say
 * @param readFailed whether the chain read threw — which is never the same as reading "nobody"
 */
export const delegationState = (
  onChain: Uint8Array | undefined,
  ours: string | null,
  readFailed: boolean,
): DelegationState => {
  if (readFailed) return 'unknown'
  if (onChain === undefined) return 'none'
  // A delegation we cannot compare against is still a delegation, and calling it `other` is the
  // honest reading: something holds this circle's gate and it is demonstrably not a commitment we
  // were able to name.
  if (ours === null) return 'other'
  return toHex(onChain).toLowerCase() === ours.toLowerCase() ? 'ours' : 'other'
}
