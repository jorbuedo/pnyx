// Witness implementations for `contract/handle.compact`.
//
// Two witnesses, and only one of them is a secret. `nameLimbs` is the sealed name's own bytes,
// supplied privately for a purely economic reason: casting `Bytes<32>` to a byte vector in-circuit
// costs ~10,800 rows — a whole K step — where recomposing supplied limbs and asserting they equal the
// sealed name costs ~680 (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.5). Nothing is hidden by it: the
// name is sealed in public ledger state, so the limbs are public knowledge that happens to travel
// through the private transcript.
import type {Witnesses} from '../../../contract/managed/handle/contract/index.js'

export type HandlePrivateState = {
  /** Account identity secret; `identityCommitment(identitySk)` is the public identity `C`. */
  readonly identitySk: Uint8Array
  /**
   * The canonical, case-folded name — 32 bytes, left-aligned and zero-padded, exactly as sealed.
   *
   * ⚠️ The circuit recomposes these **little-endian** and asserts equality with the sealed `name`, so
   * a byte order flip here fails as "limbs do not recompose to the sealed name" rather than as a
   * wrong answer.
   */
  readonly name: Uint8Array
}

export const createHandleWitnesses = (): Witnesses<HandlePrivateState> => ({
  identitySk: ({privateState}) => [privateState, privateState.identitySk],
  nameLimbs: ({privateState}) => [privateState, Array.from(privateState.name, (b) => BigInt(b))],
})
