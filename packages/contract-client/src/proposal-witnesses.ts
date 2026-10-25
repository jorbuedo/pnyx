// Witness implementations for `contract/proposal.compact` — one deploy per proposal.
//
// Separate from `circle-witnesses.ts` because they are different contracts with different `Witnesses`
// types, and the split is the point: everything that grows per *vote* lives in the proposal, so its
// private inputs do too.
//
// ⚠️ **The member path is proved against the proposal's own sealed root, not the circle's live tree.**
// The electorate is a snapshot, so this path cannot come from the proposal's ledger — the proposal holds
// no tree. The caller supplies it, from the circle's tree as of the sealed root, and the root comparison
// inside the circuit **is** the verification: a path against any other root simply fails. That is why
// the snapshot needs no trusted source.
import type {Witnesses} from '../../../contract/managed/proposal/contract/index.js'

/** The shape `proposal.compact`'s `memberPath` witness returns — a `MerkleTreePath<20, Bytes<32>>`. */
export type MemberPath = {
  readonly leaf: Uint8Array
  readonly path: readonly {readonly sibling: {readonly field: bigint}; readonly goes_left: boolean}[]
}

export type ProposalPrivateState = {
  /** Per-circle persona secret. The elector's leaf is `personaCommitment(personaSk)`. */
  readonly personaSk: Uint8Array
  /**
   * The chosen option, `0 .. optionCount - 1`. A number rather than a boolean — yes/no is simply
   * `optionCount = 2`, and the contract range-checks this against the sealed count on reveal.
   */
  readonly ballotOption: number
  /** Commitment randomness. Fresh per ballot, or two identical votes would be linkable. */
  readonly ballotRand: Uint8Array
  /**
   * The elector's path in the circle's members tree **as of the proposal's sealed root**.
   *
   * Supplied rather than looked up, because this contract has no tree to look in. A real client gets it
   * from a reconstruction of the circle's members at that root; the digests it needs are public, since
   * every `join` transaction pushes the new leaf digest into its transcript's ops program, which is a
   * public field of the `ContractCall`.
   */
  readonly memberPath: MemberPath
}

export const createProposalWitnesses = (): Witnesses<ProposalPrivateState> => ({
  personaSk: ({privateState}) => [privateState, privateState.personaSk],
  ballotOption: ({privateState}) => [privateState, BigInt(privateState.ballotOption)],
  ballotRand: ({privateState}) => [privateState, privateState.ballotRand],
  // The leaf argument is ignored deliberately: the caller already committed to a path, and returning a
  // path for a *different* leaf would fail the root check rather than mislead.
  memberPath: ({privateState}) => [
    privateState,
    privateState.memberPath as MemberPath & {path: {sibling: {field: bigint}; goes_left: boolean}[]},
  ],
})
