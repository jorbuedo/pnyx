/**
 * What leaving a circle has to do, decided before anything is submitted.
 *
 * Two halves, and they are not interchangeable. Membership is a **leaf in the circle's on-chain
 * `members` tree**; the content row is a shadow of it that makes lists and permissions cheap. So the
 * chain half goes first and the row goes last — the reverse order takes someone off every list while
 * they can still prove they belong.
 *
 * ⚠️ **Leaving is permanent.** `join` asserts against `joinedIdentities` and nothing ever removes
 * from that set, so an identity that leaves can never rejoin that circle, invite or no invite. It is
 * the same set that makes a ban permanent. Nothing here can soften that; the UI has to say it.
 *
 * | circle on chain | can prove | plan | why |
 * |---|---|---|---|
 * | no | — | `content-only` | no leaf exists, so there is nothing to remove on chain |
 * | yes | yes | `chain-then-content` | the leaf is the membership; the row follows it |
 * | yes | no | `blocked` | dropping the row alone would un-list someone who still holds the leaf |
 *
 * @module
 */

export type LeavePlan =
  /** Prove + submit `leaveCircle`, then drop the content row. */
  | {readonly kind: 'chain-then-content'; readonly contractAddress: string}
  /** The circle never confirmed on chain, so the row is the whole membership. */
  | {readonly kind: 'content-only'}
  /**
   * There is a leaf and this device cannot remove it. Refused rather than half-done: a content-only
   * leave here reads to the leaver as "you have left" while every proof they can make says otherwise.
   */
  | {readonly kind: 'blocked'; readonly reason: 'no-forum-root'}

export type LeaveInputs = {
  /** The circle's confirmed contract address, or `undefined` while its deploy is unconfirmed. */
  readonly contractAddress: string | undefined
  /** The session's anonymous-identity master — absent when the session cannot derive a persona. */
  readonly hasForumRoot: boolean
}

export const leavePlan = ({contractAddress, hasForumRoot}: LeaveInputs): LeavePlan => {
  if (contractAddress === undefined) return {kind: 'content-only'}
  if (!hasForumRoot) return {kind: 'blocked', reason: 'no-forum-root'}
  return {kind: 'chain-then-content', contractAddress}
}
