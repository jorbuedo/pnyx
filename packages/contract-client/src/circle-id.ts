// A circle's on-chain identity.
//
// The spike numbered circles with a contract-global `circleCount`, so the id was whatever the next
// insert claimed. With one contract per circle (`docs/CONTRACT_TOPOLOGY.md` split 2) there is no
// counter and nothing to claim: the id is a `Bytes<32>` **constructor argument**, chosen by the
// client before the contract exists.
//
// It is derived from the content-plane circle id rather than sampled, because it has to be
// recomputable. A joiner holding only the public circle handle can derive this id, and from it plus
// `(isOpen, founder)` the contract's address — which is what lets a client verify the address it was
// handed instead of trusting a registry (`docs/CONTRACT_MIGRATION.md`).
import {sha256} from '@noble/hashes/sha2.js'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Width of a circle's on-chain id, fixed by `circle.compact`'s `circleId: Bytes<32>`. */
export const CIRCLE_ID_BYTES = 32

/**
 * `circleId = SHA-256("pnyx:circle-id" ‖ contentCircleId)`.
 *
 * Domain-separated so the same string cannot collide with any other 32-byte derivation from the same
 * input. Deterministic and public: this is an identifier, not a secret, and every nullifier that
 * hashes it is separately keyed on a secret the device never discloses.
 */
export const circleIdFromContentId = (contentCircleId: string): Uint8Array => {
  if (contentCircleId.length === 0) throw new Error('circleIdFromContentId: contentCircleId is required')
  const label = utf8('pnyx:circle-id')
  const id = utf8(contentCircleId)
  const input = new Uint8Array(label.length + id.length)
  input.set(label)
  input.set(id, label.length)
  return sha256(input)
}

/**
 * `content = SHA-256("pnyx:proposal-content" ‖ contentProposalId)` — a proposal's on-chain identity.
 *
 * The same shape as {@link circleIdFromContentId} and for the same reason: `proposal.compact` seals
 * `content` and folds it into the deploy nonce, so this value *is* what makes the proposal's address
 * unique. Deriving it from the content-plane id rather than sampling keeps the address **recomputable**
 * — a client holding the public proposal id derives the contract's address and verifies the one it was
 * handed, instead of trusting a registry. It is also why `createProposal` is not a circuit: two authors
 * deriving the same address is a collision on identical content, not a conflict.
 *
 * ⚠️ Domain-separated from the circle label, so the same string used as both a circle id and a proposal
 * id cannot produce the same 32 bytes in the two roles.
 */
export const proposalContentFromContentId = (contentProposalId: string): Uint8Array => {
  if (contentProposalId.length === 0) throw new Error('proposalContentFromContentId: contentProposalId is required')
  const label = utf8('pnyx:proposal-content')
  const id = utf8(contentProposalId)
  const input = new Uint8Array(label.length + id.length)
  input.set(label)
  input.set(id, label.length)
  return sha256(input)
}
