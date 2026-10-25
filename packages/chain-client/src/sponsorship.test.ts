// What the sponsor will and will not pay for. Every branch here is a way our wallet could have been
// spent on someone else's transaction (docs/ABUSE_MITIGATION.md §1).
import {Transaction} from '@midnight-ntwrk/ledger-v8'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {describe, expect, it} from 'vitest'
import {PROVEN_TX_MARKERS} from './proven'
import {
  type ContractKind,
  contractCodeDigest,
  createTxDeduplicator,
  DEPLOY_ACTION,
  type DecodedSponsoredTx,
  decodeSponsoredTx,
  isSponsorshipRefusal,
  SPONSORED_CIRCLE_ENTRY_POINTS,
  SPONSORED_HANDLE_ENTRY_POINTS,
  SPONSORED_IDENTITY_ENTRY_POINTS,
  SPONSORED_PAYMENT_ENTRY_POINTS,
  SPONSORED_PROPOSAL_ENTRY_POINTS,
  SPONSORSHIP_REFUSAL_PREFIX,
  settlementMismatch,
  sponsorshipRefusal,
  undeclaredOffer,
} from './sponsorship'

const IDENTITY = 'ab'.repeat(32)
const CIRCLE = 'cd'.repeat(32)
const STRANGER = 'ef'.repeat(32)
const CIRCLE_CODE = '11'.repeat(32)
const IDENTITY_CODE = '22'.repeat(32)

const PAYMENT_CODE = '33'.repeat(32)
const HANDLE_CODE = '44'.repeat(32)
const PROPOSAL_CODE = '55'.repeat(32)

const policy = {
  identityCodeDigest: IDENTITY_CODE,
  identityEntryPoints: SPONSORED_IDENTITY_ENTRY_POINTS,
  circleCodeDigest: CIRCLE_CODE,
  circleEntryPoints: SPONSORED_CIRCLE_ENTRY_POINTS,
  proposalCodeDigest: PROPOSAL_CODE,
  proposalEntryPoints: SPONSORED_PROPOSAL_ENTRY_POINTS,
  paymentCodeDigest: PAYMENT_CODE,
  paymentEntryPoints: SPONSORED_PAYMENT_ENTRY_POINTS,
  handleCodeDigest: HANDLE_CODE,
  handleEntryPoints: SPONSORED_HANDLE_ENTRY_POINTS,
  fundTransfers: false,
}

/** The same sponsor, configured to pay for plain sends. */
const transferFunding = {...policy, fundTransfers: true}

/** Only the identity contract and one circle are ours; everything else is a stranger. */
const recognise = (address: string): ContractKind | undefined =>
  address.toLowerCase() === IDENTITY ? 'identity' : address.toLowerCase() === CIRCLE ? 'circle' : undefined

const empty = {
  calls: [],
  deploys: [],
  otherActions: 0,
  hasValueTransfer: false,
  offer: {inputs: [], outputs: [], shielded: false},
  declared: {inputs: [], outputs: []},
}

/** An unshielded colour, and an address to send it to. Any 35-byte hex will do for the comparison. */
const NIGHT = '00'.repeat(35)
const PERMIT = '11'.repeat(35)
const ALICE = 'addr_alice'
const BOB = 'addr_bob'

/** An offer, with each side written as `[colour, value, owner]` triples. */
const offer = (
  inputs: readonly [string, bigint, string][],
  outputs: readonly [string, bigint, string][],
  shielded = false,
) => ({
  offer: {
    inputs: inputs.map(([colour, value, owner]) => ({colour, value, owner})),
    outputs: outputs.map(([colour, value, owner]) => ({colour, value, owner})),
    shielded,
  },
  hasValueTransfer: inputs.length > 0 || outputs.length > 0 || shielded,
})

/** What a call's transcripts declared, as `[colour, value, owner?]` triples. */
const declares = (inputs: readonly [string, bigint][], outputs: readonly [string, bigint, string?][]) => ({
  declared: {
    inputs: inputs.map(([colour, value]) => ({colour, value, owner: undefined})),
    outputs: outputs.map(([colour, value, owner]) => ({colour, value, owner})),
  },
})

/**
 * A transaction that moves value the way a plain send does: an offer with **both** sides and nothing
 * declaring any of it.
 *
 * ⚠️ Undeclared, deliberately. The shape is no longer what decides — a paid permit is also both ways —
 * so a fixture that only set both sides would now be asserting something different from what it reads as.
 */
const spending = offer([[NIGHT, 5n, ALICE]], [[NIGHT, 5n, BOB]])

const callTx = (
  calls: {address?: string; entryPoint: string}[],
  extra: Partial<DecodedSponsoredTx> = {},
): DecodedSponsoredTx => ({
  ...empty,
  calls: calls.map((c) => ({address: c.address ?? CIRCLE, entryPoint: c.entryPoint})),
  ...extra,
})

const deployTx = (deploy: Partial<DecodedSponsoredTx['deploys'][number]> = {}): DecodedSponsoredTx => ({
  ...empty,
  deploys: [{address: CIRCLE, codeDigest: CIRCLE_CODE, immutableAuthority: true, ...deploy}],
})

// ⚠️ **The gap this pins.** The 2026-08-25 split moved voting into `proposal.compact`, a separate
// contract with its own digest, and turned proposal creation into a *deploy* — but the sponsor kept
// listing `castVote`/`revealVote` under the *circle*'s entry points and had no proposal digest at all.
// So both halves of a vote were refused, and anyone checking found `castVote` in an allowlist and
// stopped. What must hold: a proposal is recognised as its own kind, its deploy is funded, its votes
// are funded on *it*, and a vote against a circle is not.
describe('sponsorshipRefusal — proposal.compact', () => {
  const PROPOSAL = '77'.repeat(32)
  const recogniseProposal = (address: string): ContractKind | undefined =>
    address.toLowerCase() === PROPOSAL ? 'proposal' : recognise(address)

  it.each(SPONSORED_PROPOSAL_ENTRY_POINTS)('funds %s on a proposal of our template', (entryPoint) => {
    expect(sponsorshipRefusal(callTx([{address: PROPOSAL, entryPoint}]), policy, recogniseProposal)).toBeUndefined()
  })

  // Creating a proposal is a deploy — there is no `createProposal` circuit and has not been since the
  // split — so without the template in the deploy list every proposal a member writes is refused.
  it('funds a proposal deploy', () => {
    expect(
      sponsorshipRefusal(deployTx({address: PROPOSAL, codeDigest: PROPOSAL_CODE}), policy, recogniseProposal),
    ).toBeUndefined()
  })

  it.each(SPONSORED_PROPOSAL_ENTRY_POINTS)('does not fund %s against a circle', (entryPoint) => {
    expect(sponsorshipRefusal(callTx([{entryPoint}]), policy, recogniseProposal)).toMatch(/not sponsored/)
  })

  it('refuses a proposal call when no proposal digest is configured', () => {
    const unset = {...policy, proposalCodeDigest: ''}
    // Unconfigured means the address is not recognised at all, which is the honest refusal for a
    // deployment that has published no proposal artifacts.
    const bare = (address: string): ContractKind | undefined =>
      address.toLowerCase() === PROPOSAL ? undefined : recognise(address)
    expect(sponsorshipRefusal(callTx([{address: PROPOSAL, entryPoint: 'castVote'}]), unset, bare)).toMatch(
      /not deployed from a template this sponsor funds/,
    )
  })
})

describe('sponsorshipRefusal — calls', () => {
  it.each(SPONSORED_CIRCLE_ENTRY_POINTS)('funds %s on a circle of our template', (entryPoint) => {
    expect(sponsorshipRefusal(callTx([{entryPoint}]), policy, recognise)).toBeUndefined()
  })

  it.each(SPONSORED_IDENTITY_ENTRY_POINTS)('funds %s on the identity contract', (entryPoint) => {
    expect(sponsorshipRefusal(callTx([{address: IDENTITY, entryPoint}]), policy, recognise)).toBeUndefined()
  })

  // Address comparison must not be case-sensitive: hex arrives from different encoders.
  it('accepts a recognised contract in either case', () => {
    const tx = callTx([{address: CIRCLE.toUpperCase(), entryPoint: 'join'}])
    expect(sponsorshipRefusal(tx, policy, (a) => recognise(a.toLowerCase()))).toBeUndefined()
  })

  // THE attack this module exists for: using the sponsor as a general-purpose relay.
  it('refuses a call to a contract it does not recognise', () => {
    const refusal = sponsorshipRefusal(callTx([{address: STRANGER, entryPoint: 'castVote'}]), policy, recognise)
    expect(refusal).toMatch(/not deployed from a template this sponsor funds/)
  })

  // The two contracts have disjoint circuits, so an entry point valid on one is not valid on the other.
  // Without the split this would have been "allowed somewhere, therefore allowed here".
  it('refuses a circle entry point on the identity contract, and the reverse', () => {
    expect(sponsorshipRefusal(callTx([{address: IDENTITY, entryPoint: 'castVote'}]), policy, recognise)).toMatch(
      /not sponsored on the identity contract/,
    )
    expect(
      sponsorshipRefusal(callTx([{address: CIRCLE, entryPoint: 'publishIdentityRow'}]), policy, recognise),
    ).toMatch(/not sponsored on the circle contract/)
  })

  // Privileged and unbuilt circuits: sponsoring a client-supplied one would let anyone ban anyone, or
  // fund a transaction nothing we ship can send.
  //
  // ⚠️ `setInvite` is deliberately NOT in this list any more — it is moderator-gated like the two
  // above it and funded anyway, because a gated circle whose founder cannot mint a code is a
  // feature that does not work. `castVote` / `revealVote` are here because they moved to
  // `proposal.compact` at the split and were never reachable on a circle at all.
  it.each([
    'addModerator',
    'setMember',
    'createProposal',
    'castVote',
    'revealVote',
    'somethingNew',
  ])('refuses the unsponsored entry point %s even on a circle of ours', (entryPoint) => {
    expect(sponsorshipRefusal(callTx([{entryPoint}]), policy, recognise)).toMatch(/is not sponsored/)
  })
})

describe('sponsorshipRefusal — deploys', () => {
  // Creating a circle is a deploy, which carries no contract call at all. Before the structural check
  // the policy refused every one of them as "nothing for us to sponsor".
  it('funds a deploy built from our circle template', () => {
    expect(sponsorshipRefusal(deployTx(), policy, recognise)).toBeUndefined()
  })

  it('refuses a deploy of anything else, whatever address it claims', () => {
    expect(sponsorshipRefusal(deployTx({codeDigest: '99'.repeat(32)}), policy, recognise)).toMatch(
      /not built from a template this sponsor funds/,
    )
  })

  // An authority that can be satisfied lets its holder swap the verifier keys afterwards — so a contract
  // we recognised when we paid for it would stop being one, at the same address.
  it('refuses a deploy whose maintenance authority could be satisfied', () => {
    expect(sponsorshipRefusal(deployTx({immutableAuthority: false}), policy, recognise)).toMatch(
      /satisfiable maintenance authority/,
    )
  })

  it('does not consult the recogniser for a deploy — the contract does not exist yet', () => {
    const refuseEverything = () => undefined
    expect(sponsorshipRefusal(deployTx(), policy, refuseEverything)).toBeUndefined()
  })
})

describe('sponsorshipRefusal — shape', () => {
  it('refuses a batch, so one fee cannot carry many state changes', () => {
    expect(sponsorshipRefusal(callTx([{entryPoint: 'castVote'}, {entryPoint: 'castVote'}]), policy, recognise)).toMatch(
      /2 contract actions; the sponsor funds exactly one/,
    )
  })

  // A deploy riding alongside a call is still two state changes on one fee.
  it('counts calls and deploys together', () => {
    const tx = {...deployTx(), calls: [{address: CIRCLE, entryPoint: 'castVote'}]}
    expect(sponsorshipRefusal(tx, policy, recognise)).toMatch(/2 contract actions/)
  })

  it('refuses a transaction with no contract action at all', () => {
    expect(sponsorshipRefusal(callTx([]), policy, recognise)).toMatch(/no contract call or deploy/)
  })

  // An action we could not classify is one we can say nothing else about — including whether the
  // single-action rule above just let it in alongside something legitimate.
  it('refuses an action that is neither a call nor a deploy', () => {
    expect(sponsorshipRefusal({...callTx([{entryPoint: 'castVote'}]), otherActions: 1}, policy, recognise)).toMatch(
      /neither a call nor a deploy/,
    )
  })

  // We pay fees; we do not fund transfers. Checked before the contract, so the message names the real
  // problem rather than reporting an unrecognised-contract error.
  it('refuses a value transfer even on a recognised contract and an allowed entry point', () => {
    const tx = callTx([{entryPoint: 'castVote'}], spending)
    expect(sponsorshipRefusal(tx, policy, recognise)).toMatch(/no contract action declared/)
  })

  // Value riding along with a contract action stays refused whatever `fundTransfers` says: that is the
  // amortisation case, not a send.
  it('refuses a value transfer alongside a contract action even when transfers are funded', () => {
    const tx = callTx([{entryPoint: 'castVote'}], spending)
    expect(sponsorshipRefusal(tx, transferFunding, recognise)).toMatch(/no contract action declared/)
  })

  it('refuses a plain transfer unless the sponsor is configured to fund one', () => {
    const transfer = {...empty, ...spending}
    expect(sponsorshipRefusal(transfer, policy, recognise)).toMatch(/nothing for us to sponsor/)
  })

  it('funds a plain transfer when configured to', () => {
    const transfer = {...empty, ...spending}
    expect(sponsorshipRefusal(transfer, transferFunding, recognise)).toBeUndefined()
  })

  // `fundTransfers` is not "fund anything with no actions": a transaction that moves nothing buys the
  // caller a fee we paid for no reason.
  it('refuses an actionless transaction that moves nothing, even when transfers are funded', () => {
    expect(sponsorshipRefusal(empty, transferFunding, recognise)).toMatch(/neither a contract action nor a transfer/)
  })

  it('refuses an unclassifiable action even when transfers are funded', () => {
    const tx = {...empty, ...spending, otherActions: 1}
    expect(sponsorshipRefusal(tx, transferFunding, recognise)).toMatch(/neither a call nor a deploy/)
  })

  // An unconfigured policy is the empty string, and so is a digest we failed to read — so the two would
  // compare equal and fund a deploy nobody configured. Checked in the policy itself, not left to the
  // caller, because this is the object that decides.
  it('refuses a deploy when no code digest is configured, even one whose digest is also empty', () => {
    const unset = {
      ...policy,
      circleCodeDigest: '',
      identityCodeDigest: '',
      paymentCodeDigest: '',
      handleCodeDigest: '',
      proposalCodeDigest: '',
    }
    expect(sponsorshipRefusal(deployTx({codeDigest: ''}), unset, recognise)).toMatch(/no code digest/)
    expect(sponsorshipRefusal(deployTx(), unset, recognise)).toMatch(/no code digest/)
  })

  // An identity's shell is a deploy too — the first transaction a new identity makes. Refusing it would
  // leave every new user unable to publish a row at all, which is how this was found: the device built
  // the deploy, relayed it, and the sponsor said it was not a circle.
  it('funds an identity shell deploy, not only a circle', () => {
    const shell = deployTx({codeDigest: IDENTITY_CODE, address: 'aa'.repeat(32)})
    expect(sponsorshipRefusal(shell, policy, recognise)).toBeUndefined()
  })

  // A deploy whose maintenance authority can be satisfied could have its verifier keys replaced after we
  // paid for it — checked for both templates, since the identity one now takes the same path.
  it('refuses an identity shell whose maintenance authority is satisfiable', () => {
    const shell = deployTx({codeDigest: IDENTITY_CODE, immutableAuthority: false})
    expect(sponsorshipRefusal(shell, policy, recognise)).toMatch(/maintenance authority/)
  })

  // A **handle** deploy is what claiming a name is: the shell must exist before `bind` can call it.
  it('funds a handle deploy, because a claim is a deploy', () => {
    const shell = deployTx({codeDigest: HANDLE_CODE, address: 'cc'.repeat(32)})
    expect(sponsorshipRefusal(shell, policy, recognise)).toBeUndefined()
  })

  // ⚠️ Payment deploys **once**, by us, from a funded wallet. Nothing a user does should pay for a
  // second one — and a stranger deploying our payment template would be creating a rival permit issuer.
  it('refuses a payment deploy even though it funds payment calls', () => {
    const rival = deployTx({codeDigest: PAYMENT_CODE, address: 'dd'.repeat(32)})
    expect(sponsorshipRefusal(rival, policy, recognise)).toMatch(/not built from a template this sponsor funds/)
  })

  it('refuses a call when the recogniser knows nothing', () => {
    expect(sponsorshipRefusal(callTx([{entryPoint: 'castVote'}]), policy, () => undefined)).toMatch(
      /not deployed from a template this sponsor funds/,
    )
  })
})

describe('sponsorshipRefusal — the permit and name path', () => {
  const paymentCall = (entryPoint: string) => callTx([{address: 'ee'.repeat(32), entryPoint}])
  const handleCall = (entryPoint: string) => callTx([{address: 'ff'.repeat(32), entryPoint}])
  const recogniseAll = (address: string): ContractKind | undefined =>
    address === 'ee'.repeat(32) ? 'payment' : address === 'ff'.repeat(32) ? 'handle' : recognise(address)

  it.each(SPONSORED_PAYMENT_ENTRY_POINTS)('funds %s on the payment contract', (entryPoint) => {
    expect(sponsorshipRefusal(paymentCall(entryPoint), policy, recogniseAll)).toBeUndefined()
  })

  // ── A one-directional offer is not a transfer ──
  //
  // Both halves of a handle claim need one direction and cannot avoid it. `claimFreePermit` mints, so it
  // must carry an output or the node refuses the whole transaction
  // (`Custom error: 186 — Malformed::EffectsCheckFailure`, found by submitting one on 2026-08-26).
  // `bind` spends the permit that mint produced, so it must carry an input. Only value that goes out
  // *and* comes back is the amortisation the rule exists to refuse.

  it('funds a mint whose output the circuit claimed', () => {
    const tx = {
      ...paymentCall('claimFreePermit'),
      ...offer([], [[PERMIT, 1n, ALICE]]),
      ...declares([], [[PERMIT, 1n, ALICE]]),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toBeUndefined()
  })

  it('funds a call whose offer only spends what the circuit asked for', () => {
    const tx = {
      ...callTx([{address: 'ff'.repeat(32), entryPoint: 'bind'}]),
      ...offer([[PERMIT, 1n, ALICE]], []),
      ...declares([[PERMIT, 1n]], []),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toBeUndefined()
  })

  // ⚠️ The MUST FIX this replaced. A *paid* permit is payment in and permit out — both directions — so
  // the old shape rule refused every priced tier while both circuits were listed as sponsored.
  it('funds a paid permit, which moves value both ways because the circuit said so', () => {
    const tx = {
      ...paymentCall('buyPermitUnshielded'),
      ...offer([[NIGHT, 100n, ALICE]], [[PERMIT, 1n, ALICE]]),
      ...declares([[NIGHT, 100n]], [[PERMIT, 1n, ALICE]]),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toBeUndefined()
  })

  // The line, now drawn where it belongs: a rider is illegitimate because nothing declared it, not
  // because of which way it points.
  it('refuses a rider beside a declared payment', () => {
    const tx = {
      ...paymentCall('buyPermitUnshielded'),
      // 100 declared in, 150 offered: the extra 50 comes back out to the caller on our fee.
      ...offer(
        [[NIGHT, 150n, ALICE]],
        [
          [PERMIT, 1n, ALICE],
          [NIGHT, 50n, BOB],
        ],
      ),
      ...declares([[NIGHT, 100n]], [[PERMIT, 1n, ALICE]]),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toMatch(/no contract action declared/)
  })

  // A declaration names the address as well as the colour, so an output redirected elsewhere is not
  // covered by it.
  it('refuses a claimed output sent to a different address', () => {
    const tx = {
      ...paymentCall('claimFreePermit'),
      ...offer([], [[PERMIT, 1n, BOB]]),
      ...declares([], [[PERMIT, 1n, ALICE]]),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toMatch(/no contract action declared/)
  })

  // ⚠️ Opaque by construction: a zswap offer's colours, amounts and recipients are what shielding hides,
  // so there is nothing to compare a declaration against. `buyPermitShielded` is off the sponsored list
  // for this reason rather than the refusal being softened for it.
  it('refuses a shielded offer beside a call, whatever the call declared', () => {
    const tx = {
      ...paymentCall('buyPermitUnshielded'),
      ...offer([], [], true),
      ...declares([[NIGHT, 100n]], [[PERMIT, 1n, ALICE]]),
    }
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toMatch(/shielded offer/)
  })

  it('does not sponsor buyPermitShielded', () => {
    expect(SPONSORED_PAYMENT_ENTRY_POINTS).not.toContain('buyPermitShielded')
  })

  // A deploy declares nothing, so there is no offer it can carry.
  it('refuses any offer beside a deploy', () => {
    const tx = {...deployTx(), ...offer([], [[PERMIT, 1n, ALICE]])}
    expect(sponsorshipRefusal(tx, policy, recogniseAll)).toMatch(/no contract action declared/)
  })

  it.each(SPONSORED_HANDLE_ENTRY_POINTS)('funds %s on a handle contract', (entryPoint) => {
    expect(sponsorshipRefusal(handleCall(entryPoint), policy, recogniseAll)).toBeUndefined()
  })

  // ⚠️ The admin circuits are the ones worth naming: they are gated on `adminAuth`, so a stranger could
  // not prove one — but the sponsor must not be paying for *our* operations either.
  it.each([
    'setPrice',
    'grantPermit',
    'grantRebindPermit',
    'grantModeratePermit',
    'rotateAdmin',
  ])('refuses the admin circuit %s on the payment contract', (entryPoint) => {
    expect(sponsorshipRefusal(paymentCall(entryPoint), policy, recogniseAll)).toMatch(/is not sponsored/)
  })

  // A moderator surface does not exist yet, and a sponsored entry point nothing can reach is a promise
  // with no caller.
  it.each(['moderate', 'revoke'])('refuses the unreachable moderator power %s', (entryPoint) => {
    expect(sponsorshipRefusal(handleCall(entryPoint), policy, recogniseAll)).toMatch(/is not sponsored/)
  })

  // The kinds must not share a list: `bind` is a handle circuit, and funding it on the payment contract
  // would be "allowed somewhere, therefore allowed here" — the mistake the split exists to prevent.
  it('keeps the lists disjoint across kinds', () => {
    expect(sponsorshipRefusal(paymentCall('bind'), policy, recogniseAll)).toMatch(/is not sponsored/)
    expect(sponsorshipRefusal(handleCall('claimFreePermit'), policy, recogniseAll)).toMatch(/is not sponsored/)
  })
})

describe('contractCodeDigest', () => {
  const key = (byte: number) => new Uint8Array(64).fill(byte)
  const state = (entries: [string, Uint8Array][]) => ({
    operations: () => entries.map(([name]) => name),
    operation: (name: string | Uint8Array) => {
      const found = entries.find(([n]) => n === name)
      return found === undefined ? undefined : {verifierKey: found[1]}
    },
  })

  // `operations()` returns the ledger map's iteration order, not the contract's declaration order, so a
  // digest that depended on it would differ between two reads of the same contract.
  it('does not depend on the order operations() happens to return', () => {
    const entries: [string, Uint8Array][] = [
      ['castVote', key(1)],
      ['addInvite', key(2)],
      ['revealVote', key(3)],
    ]
    const forwards = contractCodeDigest(state(entries))
    const backwards = contractCodeDigest(state([...entries].reverse()))
    expect(forwards).toBe(backwards)
  })

  it('changes when any verifier key changes, and when an entry point is added or removed', () => {
    const base: [string, Uint8Array][] = [
      ['castVote', key(1)],
      ['addInvite', key(2)],
    ]
    const digest = contractCodeDigest(state(base))
    expect(
      contractCodeDigest(
        state([
          ['castVote', key(1)],
          ['addInvite', key(9)],
        ]),
      ),
    ).not.toBe(digest)
    expect(contractCodeDigest(state([...base, ['revealVote', key(3)]]))).not.toBe(digest)
    expect(contractCodeDigest(state([base[0] as [string, Uint8Array]]))).not.toBe(digest)
  })

  // Names separate from keys: without the name in the hash, two contracts with the same key set under
  // different entry points would collide.
  it('binds each key to its entry point name', () => {
    const a = contractCodeDigest(
      state([
        ['castVote', key(1)],
        ['addInvite', key(2)],
      ]),
    )
    const b = contractCodeDigest(
      state([
        ['castVote', key(2)],
        ['addInvite', key(1)],
      ]),
    )
    expect(a).not.toBe(b)
  })

  // A listed entry point we cannot read is not the same as one that is absent — treating it as absent
  // would silently produce the digest of a *different*, smaller contract.
  it('throws rather than skipping an operation it cannot read', () => {
    const broken = {operations: () => ['castVote'], operation: () => undefined}
    expect(() => contractCodeDigest(broken)).toThrow(/has no operation for it/)
  })
})

describe('decodeSponsoredTx', () => {
  const asTx = (actions: unknown[]) => ({intents: new Map([[1, {actions}]])})

  it('reads a call', () => {
    const decoded = decodeSponsoredTx(new Uint8Array([1]), () =>
      asTx([{address: CIRCLE, entryPoint: new TextEncoder().encode('castVote')}]),
    )
    expect(decoded.calls).toEqual([{address: CIRCLE, entryPoint: 'castVote'}])
    expect(decoded.deploys).toEqual([])
    expect(decoded.otherActions).toBe(0)
  })

  it('reads a deploy, its code and its authority', () => {
    const decoded = decodeSponsoredTx(new Uint8Array([1]), () =>
      asTx([
        {
          address: CIRCLE,
          initialState: {
            operations: () => ['castVote'],
            operation: () => ({verifierKey: new Uint8Array(8).fill(7)}),
            maintenanceAuthority: {committee: [], threshold: 1},
          },
        },
      ]),
    )
    expect(decoded.calls).toEqual([])
    expect(decoded.deploys).toHaveLength(1)
    expect(decoded.deploys[0]?.address).toBe(CIRCLE)
    expect(decoded.deploys[0]?.immutableAuthority).toBe(true)
  })

  it.each([
    ['a non-empty committee', {committee: [{}], threshold: 1}],
    ['a zero threshold', {committee: [], threshold: 0}],
    ['an unreadable authority', undefined],
  ])('does not call %s immutable', (_label, maintenanceAuthority) => {
    const decoded = decodeSponsoredTx(new Uint8Array([1]), () =>
      asTx([
        {
          address: CIRCLE,
          initialState: {
            operations: () => ['castVote'],
            operation: () => ({verifierKey: new Uint8Array(8)}),
            maintenanceAuthority,
          },
        },
      ]),
    )
    expect(decoded.deploys[0]?.immutableAuthority).toBe(false)
  })

  // Silently dropping what it cannot classify would report "there was nothing there", and the
  // single-action rule is what such an action would ride in on.
  it('counts an action it cannot classify instead of dropping it', () => {
    const decoded = decodeSponsoredTx(new Uint8Array([1]), () => asTx([{address: CIRCLE}, {somethingElse: true}]))
    expect(decoded).toMatchObject({calls: [], deploys: [], otherActions: 2})
  })
})

describe('settlementMismatch', () => {
  it.each([
    [DEPLOY_ACTION, 'circle'],
    // ⚠️ A proposal is a DEPLOY, and this row used to read `['createProposal', 'proposal']` — a
    // circuit that stopped existing at the 2026-08-25 split. The test kept the dead mapping alive
    // and the real pair untested, so the map would have refused every proposal the day it was
    // wired up. A test can pin rot as easily as it pins behaviour.
    [DEPLOY_ACTION, 'proposal'],
    ['join', 'membership'],
    ['setInviteAuthority', 'invite-authority'],
    ['castVote', 'vote'],
    ['revealVote', 'vote'],
  ])('accepts %s settling a %s ref', (action, kind) => {
    expect(settlementMismatch(action, kind)).toBeUndefined()
  })

  // A budget keyed on action type is trivially fooled if a cheap action can be submitted under an
  // expensive action's ref, or the reverse.
  it.each([
    ['castVote', 'circle'],
    [DEPLOY_ACTION, 'vote'],
    ['join', 'proposal'],
    // Still refused after `deploy` widened to cover proposals: widening it must not make a deploy
    // able to settle anything at all.
    [DEPLOY_ACTION, 'membership'],
  ])('refuses %s settling a %s ref', (action, kind) => {
    expect(settlementMismatch(action, kind)).toMatch(/cannot settle/)
  })

  // The row is not content-plane state, so registration settles nothing.
  it('refuses publishIdentityRow settling anything', () => {
    expect(settlementMismatch('publishIdentityRow', 'circle')).toMatch(/expected: none/)
  })

  it('refuses an action with no mapping rather than defaulting to permissive', () => {
    expect(settlementMismatch('addModerator', 'circle')).toMatch(/no settlement mapping/)
    // `createCircle` is not a circuit any more; a mapping for it would be a lie.
    expect(settlementMismatch('createCircle', 'circle')).toMatch(/no settlement mapping/)
    // Nor is `createProposal`, for the same reason — creating one is a deploy.
    expect(settlementMismatch('createProposal', 'proposal')).toMatch(/no settlement mapping/)
  })
})

describe('createTxDeduplicator', () => {
  // A proven tx that FAILS at the node still costs a balance and a submit, so replay is an unbounded
  // drain that the policy does nothing about.
  it('accepts a hash once', () => {
    const dedup = createTxDeduplicator()
    expect(dedup.accept('aa')).toBe(true)
    expect(dedup.accept('aa')).toBe(false)
    expect(dedup.accept('bb')).toBe(true)
  })

  // Unbounded memory on a long-lived host is its own exhaustion vector.
  it('evicts oldest first at capacity', () => {
    const dedup = createTxDeduplicator({capacity: 2})
    expect(dedup.accept('a')).toBe(true)
    expect(dedup.accept('b')).toBe(true)
    expect(dedup.accept('c')).toBe(true)
    expect(dedup.size()).toBe(2)
    // 'a' was evicted, so it is accepted again — the window is "recently", not "ever". An old proof is
    // stale against current contract state and fails on its own merits.
    expect(dedup.accept('a')).toBe(true)
    expect(dedup.accept('c')).toBe(false)
  })
})

// The HTTP layer classifies on this, and the status is load-bearing: Cloudflare replaces the body of any
// 5xx from a tunnel origin with its own error page, so a refusal returned as 502 loses its reason.
describe('isSponsorshipRefusal', () => {
  it('recognises a refusal thrown with the shared prefix', () => {
    expect(
      isSponsorshipRefusal(new Error(`${SPONSORSHIP_REFUSAL_PREFIX}this transaction has already been submitted`)),
    ).toBe(true)
  })

  it('recognises every refusal the policy can produce', () => {
    const refusal = sponsorshipRefusal(empty, policy, recognise)
    expect(refusal).toBeDefined()
    expect(isSponsorshipRefusal(new Error(`${SPONSORSHIP_REFUSAL_PREFIX}${refusal}`))).toBe(true)
  })

  it('does not claim a genuine downstream failure is a refusal', () => {
    expect(isSponsorshipRefusal(new Error('DustDoubleSpend: coin race'))).toBe(false)
    expect(isSponsorshipRefusal(new Error('circleCodeDigest is not configured'))).toBe(false)
  })

  it('is false for non-Error values', () => {
    expect(isSponsorshipRefusal('sponsorship refused: a bare string')).toBe(false)
    expect(isSponsorshipRefusal(undefined)).toBe(false)
  })
})

describe('decodeSponsoredTx value transfer', () => {
  // A real 1-NIGHT preprod transfer, proven-unbound and signed, built by
  // `harness/unshielded-send-preprod.ts` — the fixture `hasValueTransfer` waited on. Until this landed
  // the field was a hardcoded `false`, so the policy clause could never fire.
  const REAL_TRANSFER_B64 =
    'bWlkbmlnaHQ6dHJhbnNhY3Rpb25bdjldKHNpZ25hdHVyZVt2MV0scHJvb2YsZW1iZWRkZWQtZnJbdjFdKTpEAAgBAACVASJfoBLH' +
    'an8rl1055tivDihbaAUmADHv7O0S8X98cBW7E6YInAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA78dclLxws8TZ1oin' +
    'TRANsxRB9Oheif0x0lz5QSWyFiEABAQIAQQAEQECCT0AQesKW9gwnUSwwI3Qaq5Thk85hPCjsLyFXqY6sUOT7c4AAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARASJWYxJrmKGvr+qhYlxs5brlAKNUAaJisry1EafdSYNhjZpEaAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAABBAIAQQEFBQDBAEEEAgMGAgECAABATj/1depTj0h563slTJkhfqgN1dM5vjVTdp3K2vijJkNlKN2' +
    'u4/MhJtSkMv+M+Lnek0njyNUXRepIHUyQHCvmiUEIAgBBAwIHCQAAAQACCgspAEAAQNM24Zqc9m69L+TDBH9UMkvwK2IRUt5u8uA' +
    'zuuX8CSYedtvL8EGCAAwAAQ0CAEEBDiQAwRAgEfcVAyUzrcEojh1wRJz4WuwuKh67YTekR8hM1aBFfJUCDwsrAAccHJlcHJvZAFz' +
    '2br0v5MMEf1QyS/ArYhFS3m7y4DO65fwJJh5228vwQY='

  const deserialize = (bytes: Uint8Array) => {
    const [markerS, markerP, markerB] = PROVEN_TX_MARKERS
    return Transaction.deserialize(markerS, markerP, markerB, bytes)
  }

  it('reads a real unshielded transfer as value moving, with no contract action', () => {
    setNetworkId('preprod')
    const decoded = decodeSponsoredTx(Buffer.from(REAL_TRANSFER_B64, 'base64'), deserialize)
    expect(decoded).toMatchObject({calls: [], deploys: [], otherActions: 0, hasValueTransfer: true})
  })

  // ⚠️ The reason this fixture exists: it is the only place the *real* wasm shapes are read. The offer's
  // colours, values and owners come out of the bindings here, not out of a hand-written object, so a
  // field the ledger renamed shows up as a decode that finds nothing rather than as a green test.
  it('reads a real transfer’s offer down to colours, values and owners', () => {
    setNetworkId('preprod')
    const {offer} = decodeSponsoredTx(Buffer.from(REAL_TRANSFER_B64, 'base64'), deserialize)
    expect(offer.shielded).toBe(false)
    expect(offer.inputs.length).toBeGreaterThan(0)
    expect(offer.outputs.length).toBeGreaterThan(0)
    for (const utxo of [...offer.inputs, ...offer.outputs]) {
      // A colour or owner the decoder could not read comes back empty, which matches no declaration and
      // is therefore refused — so an empty one here would be a silently-passing check, not a strict one.
      expect(utxo.colour).toMatch(/^[0-9a-f]+$/)
      expect(utxo.owner).toMatch(/^[0-9a-f]+$/)
      expect(utxo.value).toBeGreaterThan(0n)
    }
  })

  // A transfer declares nothing, because it calls nothing — so beside a contract action every byte of it
  // is undeclared. This is the rule applied to real bytes rather than to a fixture.
  it('finds every part of a real transfer undeclared', () => {
    setNetworkId('preprod')
    const {offer, declared} = decodeSponsoredTx(Buffer.from(REAL_TRANSFER_B64, 'base64'), deserialize)
    expect(declared).toEqual({inputs: [], outputs: []})
    expect(undeclaredOffer(offer, declared)).toMatch(/against/)
  })

  it('does not call a contract call value moving', () => {
    const call = {address: 'ab'.repeat(32), entryPoint: 'castVote'}
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([[0, {actions: [call], guaranteedUnshieldedOffer: undefined}]]),
    }))
    expect(decoded.hasValueTransfer).toBe(false)
    expect(decoded.calls).toHaveLength(1)
  })

  it('does not call an offer with no inputs or outputs value moving', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([[0, {actions: [], guaranteedUnshieldedOffer: {inputs: [], outputs: []}}]]),
    }))
    expect(decoded.hasValueTransfer).toBe(false)
  })

  it('reads value in the fallible section too — a NIGHT output lands there', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([[0, {actions: [], fallibleUnshieldedOffer: {inputs: [{}], outputs: [{}]}}]]),
    }))
    expect(decoded.hasValueTransfer).toBe(true)
  })

  it('reads a shielded offer as value moving', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({guaranteedOffer: {}}))
    expect(decoded.hasValueTransfer).toBe(true)
  })
})

describe('decodeSponsoredTx — what a call declared', () => {
  const COLOUR = 'aa'.repeat(35)
  const OWNER = 'bb'.repeat(32)

  /** A transcript as the bindings shape one: effects, with maps keyed by `TokenType`. */
  const transcript = (effects: Record<string, unknown>) => ({program: [], effects})

  it('reads unshieldedInputs off a call’s transcript', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([
        [
          0,
          {
            actions: [
              {
                address: 'ab'.repeat(32),
                entryPoint: 'bind',
                fallibleTranscript: transcript({
                  unshieldedInputs: new Map([[{tag: 'unshielded', raw: COLOUR}, 1n]]),
                }),
              },
            ],
          },
        ],
      ]),
    }))
    expect(decoded.declared.inputs).toEqual([{colour: COLOUR, value: 1n, owner: undefined}])
  })

  // Keyed by `(TokenType, PublicAddress)`, which is the declaration the ledger's `well_formed` check
  // enforces against the offer — so the address is part of the answer, not decoration.
  it('reads claimedUnshieldedSpends with the address it names', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([
        [
          0,
          {
            actions: [
              {
                address: 'ab'.repeat(32),
                entryPoint: 'claimFreePermit',
                fallibleTranscript: transcript({
                  claimedUnshieldedSpends: new Map([
                    [
                      [
                        {tag: 'unshielded', raw: COLOUR},
                        {tag: 'user', address: OWNER},
                      ],
                      1n,
                    ],
                  ]),
                }),
              },
            ],
          },
        ],
      ]),
    }))
    expect(decoded.declared.outputs).toEqual([{colour: COLOUR, value: 1n, owner: OWNER}])
  })

  // A declaration paying another *contract* cannot cover an offer output an address holds, so it is
  // dropped rather than counted as an allowance somebody could spend.
  it('drops a claimed spend to a contract address', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([
        [
          0,
          {
            actions: [
              {
                address: 'ab'.repeat(32),
                entryPoint: 'claimFreePermit',
                fallibleTranscript: transcript({
                  claimedUnshieldedSpends: new Map([
                    [
                      [
                        {tag: 'unshielded', raw: COLOUR},
                        {tag: 'contract', address: OWNER},
                      ],
                      1n,
                    ],
                  ]),
                }),
              },
            ],
          },
        ],
      ]),
    }))
    expect(decoded.declared.outputs).toEqual([])
  })

  // ⚠️ Fails closed. An effects map in a shape this decoder cannot read must read as *no declaration*,
  // so the offer beside it is refused — never as a declaration covering anything.
  it('finds nothing in an effects shape it cannot read', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([
        [
          0,
          {
            actions: [
              {
                address: 'ab'.repeat(32),
                entryPoint: 'bind',
                fallibleTranscript: transcript({unshieldedInputs: 'not a map'}),
              },
            ],
          },
        ],
      ]),
    }))
    expect(decoded.declared.inputs).toEqual([])
    expect(
      undeclaredOffer(
        {inputs: [{colour: COLOUR, value: 1n, owner: OWNER}], outputs: [], shielded: false},
        decoded.declared,
      ),
    ).toMatch(/against 0 declared/)
  })

  // A deploy declares nothing at all — there is no transcript to read.
  it('declares nothing for a deploy', () => {
    const decoded = decodeSponsoredTx(new Uint8Array(), () => ({
      intents: new Map([
        [
          0,
          {
            actions: [
              {
                address: 'ab'.repeat(32),
                initialState: {operations: () => [], operation: () => undefined},
              },
            ],
          },
        ],
      ]),
    }))
    expect(decoded.declared).toEqual({inputs: [], outputs: []})
  })
})

describe('undeclaredOffer', () => {
  const A = 'aa'.repeat(35)
  const B = 'bb'.repeat(35)
  const declared = (inputs: readonly [string, bigint][], outputs: readonly [string, bigint, string?][]) => ({
    inputs: inputs.map(([colour, value]) => ({colour, value, owner: undefined})),
    outputs: outputs.map(([colour, value, owner]) => ({colour, value, owner})),
  })
  const offered = (inputs: readonly [string, bigint, string][], outputs: readonly [string, bigint, string][]) => ({
    inputs: inputs.map(([colour, value, owner]) => ({colour, value, owner})),
    outputs: outputs.map(([colour, value, owner]) => ({colour, value, owner})),
    shielded: false,
  })

  it('allows exactly what was declared', () => {
    expect(
      undeclaredOffer(offered([[A, 5n, 'x']], [[B, 1n, 'y']]), declared([[A, 5n]], [[B, 1n, 'y']])),
    ).toBeUndefined()
  })

  it('allows less than was declared', () => {
    expect(undeclaredOffer(offered([[A, 2n, 'x']], []), declared([[A, 5n]], []))).toBeUndefined()
  })

  it('refuses a colour nothing declared', () => {
    expect(undeclaredOffer(offered([[B, 1n, 'x']], []), declared([[A, 5n]], []))).toMatch(/1 in of/)
  })

  // Per colour, not in total: a declaration for one colour must not license another.
  it('does not let one colour’s allowance cover another', () => {
    expect(undeclaredOffer(offered([[A, 1n, 'x']], [[B, 1n, 'y']]), declared([[A, 1n]], [[A, 1n, 'y']]))).toMatch(
      /1 out of/,
    )
  })

  // ⚠️ The pool is consumed. An address-free declaration (`unshieldedOutputs`) authorises one amount, and
  // two recipients each claiming it in full would double it.
  it('spends an address-free allowance once, not once per recipient', () => {
    const twoRecipients = offered(
      [],
      [
        [A, 1n, 'x'],
        [A, 1n, 'y'],
      ],
    )
    expect(undeclaredOffer(twoRecipients, declared([], [[A, 2n]]))).toBeUndefined()
    expect(undeclaredOffer(twoRecipients, declared([], [[A, 1n]]))).toMatch(/1 out of/)
  })

  // Several UTXOs of one colour to one address are one amount, so a split cannot slip past a per-UTXO
  // comparison.
  it('sums several outputs to the same address', () => {
    const split = offered(
      [],
      [
        [A, 1n, 'x'],
        [A, 1n, 'x'],
      ],
    )
    expect(undeclaredOffer(split, declared([], [[A, 1n, 'x']]))).toMatch(/1 out of/)
    expect(undeclaredOffer(split, declared([], [[A, 2n, 'x']]))).toBeUndefined()
  })

  it('names an unreadable colour rather than showing an empty one', () => {
    expect(undeclaredOffer(offered([['', 1n, 'x']], []), declared([], []))).toMatch(/unreadable token type/)
  })
})
