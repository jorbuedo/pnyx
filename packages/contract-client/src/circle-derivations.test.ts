// Pinned vectors for `contract/circle.compact`'s and `contract/proposal.compact`'s derivations.
//
// What covers each edge of the three-language contract:
//   TS ↔ Compact  — `harness/circle-lifecycle.test.ts` drives the simulators with the values this
//                   module derives, so a drifted tag fails as a join or a vote the contract refuses.
//   Rust ↔ Compact — the prove-and-verify tests in `packages/midnight-native/rust/tests`.
//   TS ↔ Rust     — these vectors, duplicated in `preimage.rs`'s `mod tests`. Fast (no compiled
//                   artifacts, no SRS), so a domain-string typo fails in milliseconds.
//
// The first two vectors are stronger than a cross-language agreement: they were read off
// `joinOpenCircle`'s **own transcript** (`dump-transcript.mts joinOpenCircle`, ops 8 and 20), so they
// pin both languages against the compiled circuit rather than against each other.
import {describe, expect, it} from 'vitest'

import {
  identityJoinNullifier,
  inviteCommitment,
  personaCommitment,
  proposalActionNullifier,
  proposalDeployNonce,
  proposalVoteDomain,
} from './circle-derivations.js'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const SK = new Uint8Array(32).fill(0x0b)
const IDENTITY_SK = new Uint8Array(32).fill(0x07)
const CIRCLE_ID = new Uint8Array(32).fill(0x01)
const CONTENT = new Uint8Array(32).fill(0x0e)

describe('circle derivations — pinned vectors', () => {
  // Duplicated in packages/midnight-native/rust/src/preimage.rs `mod tests`. Change both.
  it('personaCommitment', () => {
    expect(hex(personaCommitment(SK))).toBe('3084874f4d175d5696db6822d3f485d5077b16b0f2d264b035adddc2a011f135')
  })

  it('identityJoinNullifier', () => {
    expect(hex(identityJoinNullifier(CIRCLE_ID, IDENTITY_SK))).toBe(
      'f27f56666ab187a20048db29cd616ca94ad432622284a28efaa603d40ddb7e5c',
    )
  })

  // No `inviteNullifier` beside it any more: spending an invite **removes its commitment** from
  // `invites`, so absence enforces single-use and one grow-for-ever set is gone
  // (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10).
  it('inviteCommitment', () => {
    expect(hex(inviteCommitment(IDENTITY_SK))).toBe('246a5c3233410b9b9761bc8e8cd9dae2b6c47c729ade128b8901f951a721ef00')
  })
})

// `proposal.compact`'s derivations. There is no proposal-id-keyed `actionNullifier`, because a proposal
// is its own contract and its id *is* its content commitment — so `createProposal` stopped existing.
describe('proposal derivations', () => {
  it('the vote domain is a function of the circle and the content', () => {
    const other = new Uint8Array(32).fill(0x0c)
    expect(hex(proposalVoteDomain(CIRCLE_ID, CONTENT))).toBe(hex(proposalVoteDomain(CIRCLE_ID, CONTENT)))
    expect(hex(proposalVoteDomain(CIRCLE_ID, CONTENT))).not.toBe(hex(proposalVoteDomain(CIRCLE_ID, other)))
    expect(hex(proposalVoteDomain(CIRCLE_ID, CONTENT))).not.toBe(hex(proposalVoteDomain(other, CONTENT)))
  })

  it('the deploy nonce is domain-separated from the vote domain over the same inputs', () => {
    // Both are H(tag, circleId, content) and only the tag differs. A collision would make a proposal's
    // address share a preimage with its own vote nullifiers.
    expect(hex(proposalDeployNonce(CIRCLE_ID, CONTENT))).not.toBe(hex(proposalVoteDomain(CIRCLE_ID, CONTENT)))
  })

  it('one vote per persona per proposal, and unlinkable across proposals', () => {
    const domainA = proposalVoteDomain(CIRCLE_ID, CONTENT)
    const domainB = proposalVoteDomain(CIRCLE_ID, new Uint8Array(32).fill(0x0c))
    const other = new Uint8Array(32).fill(0x0d)
    expect(hex(proposalActionNullifier(domainA, SK))).toBe(hex(proposalActionNullifier(domainA, SK)))
    expect(hex(proposalActionNullifier(domainA, SK))).not.toBe(hex(proposalActionNullifier(domainB, SK)))
    expect(hex(proposalActionNullifier(domainA, SK))).not.toBe(hex(proposalActionNullifier(domainA, other)))
  })
})

describe('circle derivations — domain separation', () => {
  it('never collides across purposes for the same secret', () => {
    const domain = proposalVoteDomain(CIRCLE_ID, CONTENT)
    const all = [
      hex(personaCommitment(SK)),
      hex(identityJoinNullifier(CIRCLE_ID, SK)),
      hex(inviteCommitment(SK)),
      hex(domain),
      hex(proposalDeployNonce(CIRCLE_ID, CONTENT)),
      hex(proposalActionNullifier(domain, SK)),
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  it('separates on the circle, which is what keeps a persona unlinkable across circles', () => {
    const other = new Uint8Array(32).fill(0x02)
    expect(hex(identityJoinNullifier(CIRCLE_ID, SK))).not.toBe(hex(identityJoinNullifier(other, SK)))
    expect(hex(proposalVoteDomain(CIRCLE_ID, CONTENT))).not.toBe(hex(proposalVoteDomain(other, CONTENT)))
  })

  it('separates on the secret', () => {
    const other = new Uint8Array(32).fill(0x0c)
    expect(hex(personaCommitment(SK))).not.toBe(hex(personaCommitment(other)))
  })
})

describe('circle derivations — argument widths', () => {
  // `circleId` became a 32-byte ledger cell; a caller still passing the spike's Field counter (or a
  // truncated hex decode) would otherwise hash a short buffer and produce a nullifier that silently
  // never matches the circuit's.
  it('refuses a circleId that is not 32 bytes', () => {
    expect(() => identityJoinNullifier(new Uint8Array(31), SK)).toThrow(/circleId must be 32 bytes/)
    expect(() => proposalDeployNonce(new Uint8Array(8), CONTENT)).toThrow(/circleId must be 32 bytes/)
  })

  it('refuses a secret or a content commitment that is not 32 bytes', () => {
    expect(() => personaCommitment(new Uint8Array(16))).toThrow(/personaSk must be 32 bytes/)
    expect(() => inviteCommitment(new Uint8Array(33))).toThrow(/inviteSecret must be 32 bytes/)
    expect(() => proposalVoteDomain(CIRCLE_ID, new Uint8Array(8))).toThrow(/content must be 32 bytes/)
    expect(() => proposalActionNullifier(new Uint8Array(8), SK)).toThrow(/voteDomain must be 32 bytes/)
  })
})
