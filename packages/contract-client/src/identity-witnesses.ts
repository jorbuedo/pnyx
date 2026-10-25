// Witness implementations for `identity.compact`. One secret, no Merkle paths — the identity
// contract authenticates by knowledge of `identitySk` alone.
import type {Witnesses} from '../../../contract/managed/identity/contract/index.js'

export type IdentityPrivateState = {
  /** Account identity secret; `identityCommitment(identitySk)` is the public identity `C`. */
  readonly identitySk: Uint8Array
}

export const createIdentityWitnesses = (): Witnesses<IdentityPrivateState> => ({
  identitySk: ({privateState}) => [privateState, privateState.identitySk],
})
