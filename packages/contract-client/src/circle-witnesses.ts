// Witness implementations for `circle.compact` — the private inputs each circuit pulls from the
// client. Merkle paths come from the current ledger view via the generated `findPathForLeaf`,
// exactly as a real client computes them from indexer state.
//
// Split from `witnesses.ts` when the contract split (`docs/CONTRACT_TOPOLOGY.md`): a circle's
// witnesses and an identity's are different sets, and one contract's `Witnesses` type cannot
// describe the other.
import type {Witnesses} from '../../../contract/managed/circle/contract/index.js'

export type CirclePrivateState = {
  /** Account identity secret. Its join nullifier is what limits a circle to one join per identity. */
  readonly identitySk: Uint8Array
  /** Per-circle persona secret. The member leaf is `personaCommitment(personaSk)`. */
  readonly personaSk: Uint8Array
  /** The invite being redeemed, when joining a gated circle. */
  readonly inviteSecret: Uint8Array
  /**
   * The delegated invite-issuer's secret, for `issueInvite`.
   *
   * Optional because almost nobody holds one: it belongs to the attestation service a circle
   * delegated to, not to a member. Absent resolves to 32 zero bytes, whose commitment matches no
   * circle's `inviteAuthority` — so a caller without it fails the *gate* rather than the witness,
   * which is the right shape: "you are not the authority" is an authorisation answer, not a
   * missing input.
   */
  readonly inviteAuthoritySk?: Uint8Array
}

export const createCircleWitnesses = (): Witnesses<CirclePrivateState> => ({
  identitySk: ({privateState}) => [privateState, privateState.identitySk],
  personaSk: ({privateState}) => [privateState, privateState.personaSk],
  inviteSecret: ({privateState}) => [privateState, privateState.inviteSecret],
  inviteAuthoritySk: ({privateState}) => [privateState, privateState.inviteAuthoritySk ?? new Uint8Array(32)],
  memberPath: ({ledger, privateState}, leaf) => {
    const path = ledger.members.findPathForLeaf(leaf)
    // Never substitute an empty path: a wrong one fails at proving with a message about roots,
    // which reads as a chain problem rather than "this persona is not a member".
    if (path === undefined) throw new Error('memberPath witness: leaf not present in members tree')
    return [privateState, path]
  },
  moderatorPath: ({ledger, privateState}, leaf) => {
    const path = ledger.moderators.findPathForLeaf(leaf)
    if (path === undefined) throw new Error('moderatorPath witness: leaf not present in moderators tree')
    return [privateState, path]
  },
})
