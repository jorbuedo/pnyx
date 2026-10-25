// `circle.compact` and `proposal.compact` end to end against real witnesses.
//
// The split (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10) moved every structure that grew per *vote* into
// a per-proposal contract, so this file now drives two simulators and the seam between them is the
// property worth proving: a proposal seals the circle's members root, and a voter proves a path against
// that sealed root rather than against the live tree.
//
// ⚠️ **A ban therefore does not reach a proposal already open.** That is deliberate, not a gap — the
// electorate is a snapshot, proposals are short-lived and bans are rare. The alternative (a live
// electorate via `kernel.claimContractCall`, which our toolchain does expose) costs an entry point on
// each side, two proofs per vote and a hand-assembled two-call transaction. Both halves of that trade
// are pinned below.
//
// It doubles as the TS ↔ Compact edge for `circle-derivations.ts`: the leaves, invite commitments and
// vote domains below come from that module, so a drifted domain tag fails here as a join or a vote the
// contract rejects.

import {bytes32} from '@pnyx/contract-client/bytes'
import {
  identityJoinNullifier,
  inviteAuthorityCommitment,
  inviteCommitment,
  personaCommitment,
} from '@pnyx/contract-client/circle-derivations'
import {createCircleSimulator} from '@pnyx/contract-client/circle-simulator'
import type {CirclePrivateState} from '@pnyx/contract-client/circle-witnesses'
import {createProposalSimulator, type ProposalSimulator} from '@pnyx/contract-client/proposal-simulator'
import type {MemberPath} from '@pnyx/contract-client/proposal-witnesses'
import {describe, expect, it} from 'vitest'

const CIRCLE_ID = bytes32(99)
const CONTENT = bytes32(77)
const alice: CirclePrivateState = {identitySk: bytes32(1), personaSk: bytes32(11), inviteSecret: bytes32(21)}
const bob: CirclePrivateState = {identitySk: bytes32(2), personaSk: bytes32(12), inviteSecret: bytes32(22)}
const carol: CirclePrivateState = {identitySk: bytes32(3), personaSk: bytes32(13), inviteSecret: bytes32(23)}
const founderPersona = personaCommitment(alice.personaSk)
const FOUNDER_AUTH = bytes32(0x61)
const FOUNDER_JOINED = identityJoinNullifier(CIRCLE_ID, alice.identitySk)

const gatedCircle = () =>
  createCircleSimulator(alice, {circleId: CIRCLE_ID, isOpen: false, founderModerator: founderPersona, founderAuth: FOUNDER_AUTH, founderJoined: FOUNDER_JOINED})
const openCircle = () =>
  createCircleSimulator(alice, {circleId: CIRCLE_ID, isOpen: true, founderModerator: founderPersona, founderAuth: FOUNDER_AUTH, founderJoined: FOUNDER_JOINED})

describe('circle lifecycle', () => {
  it('runs invite → join', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.setPrivateState(bob)
    sim.call('join')
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeDefined()
  })

  // The founder is seated as a member by the constructor, which is what makes a *gated* circle
  // creatable at all: joining one needs an invite, so a founder would otherwise have to invite
  // themselves and redeem it before they could post in the community they had just made.
  it('seats the founder as a member and spends their join nullifier', () => {
    const sim = gatedCircle()
    expect(sim.getLedger().members.findPathForLeaf(founderPersona)).toBeDefined()
    expect(sim.getLedger().joinedIdentities.member(FOUNDER_JOINED)).toBe(true)
    // And the nullifier is what stops them holding two leaves: a second join with a fresh persona is
    // refused by the identity they cannot change, not by the persona they can.
    sim.call('setInvite', inviteCommitment(bytes32(31)), true)
    sim.setPrivateState({...alice, personaSk: bytes32(98), inviteSecret: bytes32(31)})
    expect(() => sim.call('join')).toThrow(/identity already joined/)
  })

  // The auth key is what lets the content plane authenticate a moderator without learning which
  // member they are: it can read *which leaves* moderate a circle, but not which session owns one, and
  // recording that link at `join` would mean storing it for every member of every circle.
  it('seats the founder auth key at construction and pairs one with every promotion', () => {
    const sim = openCircle()
    // Nothing but the constructor could have put the founder's key here.
    expect(sim.getLedger().moderatorAuth.lookup(founderPersona)).toEqual(FOUNDER_AUTH)

    // Promotion is the other writer. Bob must be a member first — `addModerator` checks both trees.
    sim.setPrivateState(bob)
    sim.call('join')
    const bobLeaf = personaCommitment(bob.personaSk)
    sim.setPrivateState(alice)
    const bobAuth = bytes32(0x62)
    sim.call('addModerator', bobLeaf, bobAuth)

    expect(sim.getLedger().moderators.findPathForLeaf(bobLeaf)).toBeDefined()
    expect(sim.getLedger().moderatorAuth.lookup(bobLeaf)).toEqual(bobAuth)
    // The founder's row is untouched: the map is per persona, not a single current-moderator cell.
    expect(sim.getLedger().moderatorAuth.lookup(founderPersona)).toEqual(FOUNDER_AUTH)

    // And a member who was never promoted has no row at all — which is what makes the reads above
    // assertions about written state rather than about a map that answers anything.
    sim.setPrivateState(carol)
    sim.call('join')
    expect(sim.getLedger().moderatorAuth.member(personaCommitment(carol.personaSk))).toBe(false)
  })

  it('admits more than one member — the spike could only ever admit one', () => {
    const sim = gatedCircle()
    // The founder is already in; two more join on invites, so the tree holds three distinct leaves.
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.call('setInvite', inviteCommitment(carol.inviteSecret), true)
    sim.setPrivateState(bob)
    sim.call('join')
    sim.setPrivateState(carol)
    sim.call('join')
    expect(sim.getLedger().members.findPathForLeaf(founderPersona)).toBeDefined()
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeDefined()
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(carol.personaSk))).toBeDefined()
  })

  it('refuses a second join by the same identity, even with a fresh persona and invite', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.call('setInvite', inviteCommitment(bytes32(23)), true)
    sim.setPrivateState(bob)
    sim.call('join')
    sim.setPrivateState({...bob, personaSk: bytes32(99), inviteSecret: bytes32(23)})
    expect(() => sim.call('join')).toThrow(/identity already joined/)
  })

  // Single-use is now enforced by **absence**: joining removes the commitment from `invites`, which is
  // what let the grow-for-ever `spentInvites` set be deleted. So a replay fails as "no such invite"
  // rather than "invite already used" — same refusal, one fewer structure.
  it('spends an invite by removing it, so a reuse finds nothing', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    expect([...sim.getLedger().invites]).toHaveLength(1)
    sim.setPrivateState(bob)
    sim.call('join')
    expect([...sim.getLedger().invites]).toHaveLength(0)
    sim.setPrivateState({...carol, inviteSecret: bob.inviteSecret})
    expect(() => sim.call('join')).toThrow(/no such invite/)
  })

  // Re-issuing the same commitment revives that invite, which is exactly what re-inviting means.
  it('can re-issue a spent invite', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.setPrivateState(bob)
    sim.call('join')
    sim.setPrivateState(alice)
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    expect([...sim.getLedger().invites]).toHaveLength(1)
  })

  it('refuses a revoked invite', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), false)
    sim.setPrivateState(bob)
    expect(() => sim.call('join')).toThrow(/no such invite/)
  })

  // Revoking nothing is a moderator acting on a stale view, not a no-op to shrug at — and it is the
  // one branch of the merged `setInvite` that has an assert of its own.
  it('refuses revoking an invite that was never issued', () => {
    const sim = gatedCircle()
    expect(() => sim.call('setInvite', inviteCommitment(bytes32(42)), false)).toThrow(/no such invite/)
  })

  it('refuses a join with no invite on a gated circle', () => {
    const sim = gatedCircle()
    sim.setPrivateState(bob)
    expect(() => sim.call('join')).toThrow(/no such invite/)
  })

  it('lets anyone join an open circle with no invite at all', () => {
    const sim = openCircle()
    sim.setPrivateState(bob)
    sim.call('join')
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeDefined()
    // The invite registry is untouched on this path — an open circle never consults it.
    expect([...sim.getLedger().invites]).toHaveLength(0)
  })

  // The one-join-per-identity rule is what a ban rests on, so it has to hold on the open path too,
  // where there is no invite to spend.
  it('still refuses a second join by the same identity on an open circle', () => {
    const sim = openCircle()
    sim.setPrivateState(bob)
    sim.call('join')
    sim.setPrivateState({...bob, personaSk: bytes32(97)})
    expect(() => sim.call('join')).toThrow(/identity already joined/)
  })

  // Root history is permanent now — the reset that `setMember` used to call is gone, because votes left
  // this contract. Permanence is what makes a proposal's sealed electorate checkable by a client.
  it('keeps every historic root, so a sealed electorate stays verifiable', () => {
    const sim = openCircle()
    sim.setPrivateState(bob)
    sim.call('join')
    const afterJoin = sim.getLedger().members.root()
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    expect(sim.getLedger().members.checkRoot(afterJoin)).toBe(true)
  })
})

describe('the delegated invite authority', () => {
  // The attestation service's secret. A circle delegates by storing its commitment; the service
  // proves knowledge of the preimage. Compact 0.23 has no in-circuit signature check and no
  // `kernel.caller()`, so a commitment is the only authority the contract can express.
  const ATTESTOR_SK = bytes32(0xa7)
  const ATTESTOR = inviteAuthorityCommitment(ATTESTOR_SK)

  /**
   * The attestor calling in.
   *
   * ⚠️ A persona of its own that never joined — **not** `{...alice}`. The first version of this
   * helper spread the founder's state, so the "attestor" was quietly still a moderator and the
   * least-privilege assertion below passed for the wrong reason.
   */
  const attestor: CirclePrivateState = {
    identitySk: bytes32(0xa1),
    personaSk: bytes32(0xa2),
    inviteSecret: bytes32(0xa3),
  }
  const asAttestor = (sim: ReturnType<typeof gatedCircle>, sk = ATTESTOR_SK) => {
    sim.setPrivateState({...attestor, inviteAuthoritySk: sk})
  }

  it('issues an invite that a joiner can then redeem', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    asAttestor(sim)
    sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)

    sim.setPrivateState(bob)
    sim.call('join')
    expect(sim.getLedger().members.firstFree()).toBe(2n)
  })

  // ⚠️ The whole point of the field. Without the zero check, a circle that never delegated would be
  // wide open to anyone who could produce a preimage of the zero value.
  it('refuses issuance on a circle that delegated to nobody', () => {
    const sim = gatedCircle()
    asAttestor(sim)
    expect(() => sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)).toThrow(
      /not the invite authority/,
    )
  })

  it('refuses a caller holding the wrong secret', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    asAttestor(sim, bytes32(0xbb))
    expect(() => sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)).toThrow(
      /not the invite authority/,
    )
  })

  // ⚠️ **This is the property that made an authority preferable to `addModerator`.** `moderators` is
  // insert-only — no circuit removes a leaf — so delegating by promotion is permanent. This is not.
  it('can be withdrawn, and issuance stops immediately', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    asAttestor(sim)
    sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)

    sim.setPrivateState(alice)
    sim.call('setInviteAuthority', new Uint8Array(32))
    asAttestor(sim)
    expect(() => sim.call('issueInvite', inviteCommitment(carol.inviteSecret), true)).toThrow(
      /not the invite authority/,
    )
  })

  it('can be rotated, and the old secret stops working', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    const NEXT_SK = bytes32(0xc9)
    sim.setPrivateState(alice)
    sim.call('setInviteAuthority', inviteAuthorityCommitment(NEXT_SK))

    asAttestor(sim)
    expect(() => sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)).toThrow(
      /not the invite authority/,
    )
    asAttestor(sim, NEXT_SK)
    sim.call('issueInvite', inviteCommitment(bob.inviteSecret), true)
    expect(sim.getLedger().invites.member(inviteCommitment(bob.inviteSecret))).toBe(true)
  })

  // ⚠️ The bound on what the delegation grants. An authority may write `invites` and nothing else —
  // it cannot ban, cannot seat a persona, cannot promote. That is the entire reason this exists
  // rather than `addModerator(attestor)`.
  it('grants no moderator power beyond issuing', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    asAttestor(sim)
    // A non-member persona has no leaf, so these fail at the moderator gate rather than at the
    // action — which is the correct refusal either way.
    expect(() => sim.call('setMember', personaCommitment(bob.personaSk), true)).toThrow()
    expect(() => sim.call('addModerator', founderPersona, bytes32(0x62))).toThrow()
    expect(() => sim.call('setInviteAuthority', bytes32(0xff))).toThrow()
  })

  it('may also revoke an invite it issued', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    asAttestor(sim)
    const c = inviteCommitment(bob.inviteSecret)
    sim.call('issueInvite', c, true)
    sim.call('issueInvite', c, false)
    expect(sim.getLedger().invites.member(c)).toBe(false)
  })

  it('is moderator-only to set', () => {
    const sim = gatedCircle()
    sim.setPrivateState(bob)
    expect(() => sim.call('setInviteAuthority', ATTESTOR)).toThrow()
  })

  // A moderator's own path is untouched by the delegation — both issuers coexist.
  it('leaves the moderator able to issue as before', () => {
    const sim = gatedCircle()
    sim.call('setInviteAuthority', ATTESTOR)
    sim.call('setInvite', inviteCommitment(carol.inviteSecret), true)
    expect(sim.getLedger().invites.member(inviteCommitment(carol.inviteSecret))).toBe(true)
  })
})

describe('bans', () => {
  const joined = () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.setPrivateState(bob)
    sim.call('join')
    return sim
  }

  it('removes the leaf, so there is nothing left to prove membership with', () => {
    const sim = joined()
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeUndefined()
    sim.setPrivateState(bob)
    expect(() => sim.call('leaveCircle')).toThrow(/not present in members tree/)
  })

  it('cannot be rejoined afterwards — the identity nullifier is spent', () => {
    const sim = joined()
    sim.setPrivateState(alice)
    sim.call('setInvite', inviteCommitment(bytes32(24)), true)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    sim.setPrivateState({...bob, personaSk: bytes32(98), inviteSecret: bytes32(24)})
    expect(() => sim.call('join')).toThrow(/identity already joined/)
  })

  it('leaves other members untouched', () => {
    const sim = gatedCircle()
    sim.call('setInvite', inviteCommitment(bob.inviteSecret), true)
    sim.setPrivateState(bob)
    sim.call('join')
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    // The founder's own leaf, seated by the constructor, survives a ban aimed at someone else.
    expect(sim.getLedger().members.findPathForLeaf(founderPersona)).toBeDefined()
  })

  // Refused at the witness stage — a non-moderator cannot even build the proof. That is a genuine
  // refusal, but it is not the contract's assert; forging a path to exercise that needs a harness
  // the simulator does not offer.
  it('is moderator-only', () => {
    const sim = joined()
    expect(() => sim.call('setMember', personaCommitment(alice.personaSk), false)).toThrow(
      /not present in moderators tree/,
    )
  })

  it('can be undone', () => {
    const sim = joined()
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    sim.call('setMember', personaCommitment(bob.personaSk), true)
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeDefined()
  })

  it('lets a member leave on their own authority', () => {
    const sim = joined()
    sim.call('leaveCircle')
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeUndefined()
  })
})

// The seam between the two contracts. A proposal is a *deploy*, so there is no `createProposal` circuit
// and nothing about a proposal is a circle write — two authors can never conflict.
describe('proposals — the electorate is a snapshot', () => {
  /** A circle with alice (founder/moderator, seated by the constructor) and bob joined. */
  const populated = () => {
    const sim = openCircle()
    sim.setPrivateState(bob)
    sim.call('join')
    return sim
  }

  const pathFor = (sim: ReturnType<typeof openCircle>, personaSk: Uint8Array): MemberPath => {
    const path = sim.getLedger().members.findPathForLeaf(personaCommitment(personaSk))
    if (path === undefined) throw new Error('leaf not in the members tree')
    return path as MemberPath
  }

  const proposalFor = (
    sim: ReturnType<typeof openCircle>,
    voter: CirclePrivateState,
    opts: {optionCount?: number; option?: number; root?: bigint; path?: MemberPath} = {},
  ): ProposalSimulator =>
    createProposalSimulator(
      {
        personaSk: voter.personaSk,
        ballotOption: opts.option ?? 0,
        ballotRand: bytes32(200),
        memberPath: opts.path ?? pathFor(sim, voter.personaSk),
      },
      {
        circleId: CIRCLE_ID,
        membersRoot: opts.root ?? sim.getLedger().members.root().field,
        content: CONTENT,
        author: personaCommitment(alice.personaSk),
        optionCount: opts.optionCount ?? 2,
      },
    )

  it('seeds every option at zero, so "no votes" is not "no such option"', () => {
    const p = proposalFor(populated(), bob, {optionCount: 4})
    // Sorted: `tallies` is a hash map, so iteration order is by key hash rather than by option.
    const seeded = [...p.getLedger().tallies].map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0])
    expect(seeded).toEqual([
      [0, 0n],
      [1, 0n],
      [2, 0n],
      [3, 0n],
    ])
    expect(p.getLedger().optionCount).toBe(4n)
  })

  it('runs castVote → revealVote and counts the chosen option', () => {
    const p = proposalFor(populated(), bob, {optionCount: 4, option: 2})
    p.call('castVote')
    expect([...p.getLedger().voted]).toHaveLength(1)
    expect([...p.getLedger().commits]).toHaveLength(1)

    p.call('revealVote')
    expect(p.getLedger().tallies.lookup(2n)).toBe(1n)
    expect(p.getLedger().tallies.lookup(0n)).toBe(0n)
    // The sealed ballot is deleted on reveal, so the per-vote structure shrinks back to empty; the
    // turnout-bounded set is the only thing that stays.
    expect([...p.getLedger().commits]).toHaveLength(0)
    expect([...p.getLedger().voted]).toHaveLength(1)
  })

  it('counts more than two options — yes/no is just optionCount = 2', () => {
    const sim = populated()
    const first = proposalFor(sim, bob, {optionCount: 3, option: 2})
    first.call('castVote')
    first.call('revealVote')
    // A second elector votes a different option on the same proposal.
    first.setPrivateState({
      personaSk: alice.personaSk,
      ballotOption: 0,
      ballotRand: bytes32(201),
      memberPath: pathFor(sim, alice.personaSk),
    })
    first.call('castVote')
    first.call('revealVote')
    expect(first.getLedger().tallies.lookup(0n)).toBe(1n)
    expect(first.getLedger().tallies.lookup(1n)).toBe(0n)
    expect(first.getLedger().tallies.lookup(2n)).toBe(1n)
  })

  it('refuses a second vote by the same persona', () => {
    const p = proposalFor(populated(), bob)
    p.call('castVote')
    expect(() => p.call('castVote')).toThrow(/already voted/)
  })

  it('refuses a ballot that does not open to its commitment', () => {
    const p = proposalFor(populated(), bob, {optionCount: 4, option: 1})
    p.call('castVote')
    p.setPrivateState({...p.getPrivateState(), ballotOption: 3})
    expect(() => p.call('revealVote')).toThrow(/ballot does not open/)
  })

  it('refuses an option outside the sealed count', () => {
    // A commitment can be opened to any `Uint<8>`, so the range check is what stops a vote landing in
    // a tally row the constructor never seeded.
    const p = proposalFor(populated(), bob, {optionCount: 2, option: 7})
    p.call('castVote')
    expect(() => p.call('revealVote')).toThrow(/no such option/)
  })

  it('refuses a path that does not reach the sealed root', () => {
    const sim = populated()
    const p = proposalFor(sim, bob, {root: sim.getLedger().members.root().field + 1n})
    expect(() => p.call('castVote')).toThrow(/not in the electorate/)
  })

  // The snapshot's two halves, both deliberate. Recorded in §10 and chosen over a live electorate.
  it('lets a member banned AFTER creation still vote — the electorate is frozen', () => {
    const sim = populated()
    const p = proposalFor(sim, bob)
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    expect(sim.getLedger().members.findPathForLeaf(personaCommitment(bob.personaSk))).toBeUndefined()
    // The proposal sealed the earlier root, and bob's path still reaches it.
    expect(() => p.call('castVote')).not.toThrow()
  })

  it('excludes a banned member from a proposal created after the ban', () => {
    const sim = populated()
    const bobPath = pathFor(sim, bob.personaSk)
    sim.setPrivateState(alice)
    sim.call('setMember', personaCommitment(bob.personaSk), false)
    const p = proposalFor(sim, bob, {path: bobPath})
    expect(() => p.call('castVote')).toThrow(/not in the electorate/)
  })

  it('excludes someone who joined after creation', () => {
    const sim = openCircle()
    const p = proposalFor(sim, alice)
    // Bob joins after the proposal sealed its root.
    sim.setPrivateState(bob)
    sim.call('join')
    const latePath = pathFor(sim, bob.personaSk)
    p.setPrivateState({...p.getPrivateState(), personaSk: bob.personaSk, memberPath: latePath})
    expect(() => p.call('castVote')).toThrow(/not in the electorate/)
  })
})
