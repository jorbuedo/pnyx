// Client-side mirrors of `contract/circle.compact`'s domain-separated derivations.
//
// A client computes these off-chain to pre-check nullifiers and to find its own leaf before asking
// for a Merkle path, so every one of them exists in three languages — the circuit, this module, and
// `packages/midnight-native/rust/src/preimage.rs` — and all three must agree byte-for-byte or a
// natively-built proof will not verify.
//
// Separate from `derivations.ts` because the shapes genuinely changed with the contract split, and
// its join nullifier is keyed on the **identity** secret rather than the persona's. Sharing a module
// would leave two same-named derivations one import away from each other, which is how the wrong one
// gets called and the proof fails somewhere else entirely.
//
// The vote derivations live here too, but they belong to `proposal.compact` — one deploy per proposal
// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10) — because they are keyed on the *circle* and read
// alongside these.
//
// `circleId` is a `Bytes<32>` ledger cell the circuits read, not the spike's Field counter — hence
// `Uint8Array` here rather than `bigint`.
// No `@midnight-ntwrk/compact-runtime` — see `derivations.ts` on why importing it breaks the Android
// build. `persistentHash32` is the same hash without the WASM.
import {pad32, persistentHash32} from './derivations.js'

const requireBytes32 = (name: string, value: Uint8Array): Uint8Array => {
  if (value.length !== 32) {
    throw new Error(`${name} must be 32 bytes, got ${value.length}`)
  }
  return value
}

/**
 * A member's leaf in the `members` tree, and a proposal author's public label.
 *
 * The **only** thing the tree stores: there is no separate leaf derivation binding the circle, the
 * way the spike's `memberLeaf(circleId, sk)` did. It does not need one — the tree belongs to one
 * circle's contract, so the binding that used to be inside the hash is now structural.
 */
export const personaCommitment = (personaSk: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:pc'), requireBytes32('personaSk', personaSk)])

/**
 * One join per identity, without naming the identity — the nullifier `joinCircle` and
 * `joinOpenCircle` both insert into `joinedIdentities`.
 *
 * Keyed on `identitySk`, not `personaSk`: a client picks its own persona, so a persona-keyed
 * nullifier would let a banned user rejoin under a fresh one. Still unlinkable to `C`, which is a
 * different one-way function of the same secret, and unlinkable across circles because `circleId`
 * is in the hash.
 */
export const identityJoinNullifier = (circleId: Uint8Array, identitySk: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:jni'), requireBytes32('circleId', circleId), requireBytes32('identitySk', identitySk)])

/** The commitment a moderator publishes with `addInvite`, hiding the secret until it is redeemed. */
export const inviteCommitment = (inviteSecret: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:invite'), requireBytes32('inviteSecret', inviteSecret)])

/**
 * The commitment a circle stores in `inviteAuthority` — what its delegated issuer proves knowledge
 * of, and what `setInviteAuthority` writes.
 *
 * ⚠️ Its own domain tag (`pnyx:ia`), like every derivation here. The same 32 bytes used as a
 * persona secret elsewhere must not also authorise invite issuance, and a shared tag is exactly how
 * that happens.
 *
 * ⚠️ **Never the invite secret's tag.** `inviteCommitment` above hashes a single-use capability;
 * this hashes a standing authority. Colliding them would make any issued invite an authority to
 * issue more.
 */
export const inviteAuthorityCommitment = (authoritySk: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:ia'), requireBytes32('authoritySk', authoritySk)])

/**
 * The deploy nonce of `proposal(circleId, content)` — a proposal **is** a deploy, so this is what makes
 * two authors of the same content collide and two authors of different content never conflict.
 *
 * Arity 3 deliberately: folding a fourth element in-circuit costs 5,691 rows against arity 3's 99
 * (§10), which is why the proposal has no counter and no index — the id *is* the content commitment.
 *
 * ⚠️ **The nonce is only half the address.** The full derivation is
 * `SHA-256(tagged_serialize(ContractDeploy {initial_state, nonce}))`, and the JS ledger's
 * `ContractDeploy` samples its own nonce and ignores one passed in — so the serialization needs the
 * native Rust rail, exactly as a circle's and a handle's do.
 */
export const proposalDeployNonce = (circleId: Uint8Array, content: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:proposal'), requireBytes32('circleId', circleId), requireBytes32('content', content)])

/**
 * `proposal.compact`'s sealed `voteDomain` — what its vote nullifiers are domain-separated by.
 *
 * Computed in the proposal's constructor and sealed, so it is part of the address and cannot disagree
 * with it. Precomputing it is what lets the nullifier below be an arity-**2** hash instead of arity 4.
 */
export const proposalVoteDomain = (circleId: Uint8Array, content: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:an'), requireBytes32('circleId', circleId), requireBytes32('content', content)])

/**
 * Vote-once, per proposal per persona. The only thing `castVote` discloses — pairing it with the
 * persona would undo the sealed ballot, because `revealVote` already pairs it with the chosen option.
 *
 * Arity 2: `voteDomain` already carries the tag, the circle and the proposal.
 */
export const proposalActionNullifier = (voteDomain: Uint8Array, personaSk: Uint8Array): Uint8Array =>
  persistentHash32([requireBytes32('voteDomain', voteDomain), requireBytes32('personaSk', personaSk)])
