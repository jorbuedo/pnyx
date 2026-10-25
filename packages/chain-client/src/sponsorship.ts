// What the sponsor is willing to pay for.
//
// `POST /chain/submit` and `POST /register` hand us proven transaction bytes and we bind our DUST fee to
// them. Until this module existed the only check was "non-empty Uint8Array" (`proven.ts`), so a session
// holder could have the sponsor balance, sign and submit **any** proven Midnight transaction — including
// one against an unrelated contract. Not a forgery hole, because the circuits need witnesses we do not
// hold and we cannot author what we relay; but a general-purpose transaction relay funded by our wallet,
// which for a fee-paying service is the entire loss. See `docs/ABUSE_MITIGATION.md` §1.
//
// The decision is split from the decoding on purpose: the policy is where the mistakes are, and a policy
// that needs a real proven transaction to exercise is a policy nobody tests.
//
// ## Why an address list stopped working
//
// The first version of this was "one contract address, one list of entry points". The contract split
// (`docs/CONTRACT_TOPOLOGY.md`) invalidated every clause of it: creating a circle is a **deploy**, which
// carries no contract call for an entry point to match, and every later call targets a **per-circle**
// address that does not exist when this host is configured and could never be enumerated in advance.
//
// So the question changed from *"is this the address we fund?"* to *"is this one of our contracts?"* —
// and that is answerable structurally, because a contract's `operations` map carries one verifier key per
// entry point and those keys **are** the contract's code. Hashing them gives the same `codeDigest` the
// artifact service already computes and serves, so one 64-hex value in the sponsor's config recognises
// every circle that will ever be deployed from our compiled template, and nothing else.
//
// That digest is a fact about the **template**, not about a deployment, which is what keeps the promise
// in `docs/SPONSOR_HOST.md` intact: nothing on this host depends on a deployed contract, and a redeploy
// still needs no rebuild.
import {sha256} from '@noble/hashes/sha2.js'

/** Which of our contracts an address turned out to be. */
export type ContractKind = 'identity' | 'circle' | 'proposal' | 'payment' | 'handle'

/** A contract deploy we were asked to fund, read down to the facts the policy decides on. */
export type DecodedDeploy = {
  /** The address it will create. Derived from the deploy's own contents, so nobody can move it. */
  readonly address: string
  /** SHA-256 over its entry points' verifier keys — see {@link contractCodeDigest}. */
  readonly codeDigest: string
  /**
   * Whether its maintenance authority can never be satisfied, i.e. whether the contract is immutable.
   *
   * Circles are immutable by decision (`docs/CONTRACT_MIGRATION.md`), and it is not a detail we can
   * shrug at here: an authority that *can* be satisfied lets its holder swap the verifier keys after
   * the fact, which would turn a contract we recognised today into one we do not, at the same address.
   */
  readonly immutableAuthority: boolean
}

/** What we managed to read out of a proven transaction, in policy terms. */
export type DecodedSponsoredTx = {
  /** One entry per contract call, in order. */
  readonly calls: readonly {readonly address: string; readonly entryPoint: string}[]
  /** One entry per contract deploy, in order. */
  readonly deploys: readonly DecodedDeploy[]
  /**
   * Actions that are neither: maintenance updates, and anything a future ledger version adds.
   *
   * Counted rather than dropped. A decoder that silently ignores what it does not understand turns
   * "we could not classify this" into "there was nothing there", and the policy's single-action rule
   * is exactly what such an action would ride in on.
   */
  readonly otherActions: number
  /** Whether the transaction moves value in its own right, rather than only calling contracts. */
  readonly hasValueTransfer: boolean
  /** What the transaction's offers actually move. */
  readonly offer: OfferedValue
  /**
   * What the calls' transcripts said they would move.
   *
   * Empty for a deploy, which declares nothing — so any offer beside one is undeclared.
   */
  readonly declared: DeclaredValue
}

/** One entry per unshielded UTXO an offer names. `owner` is a user address. */
export type OfferedUtxo = {readonly colour: string; readonly value: bigint; readonly owner: string}

/** What a transaction's offers move. */
export type OfferedValue = {
  /** UTXOs spent into the transaction — value the caller provides. */
  readonly inputs: readonly OfferedUtxo[]
  /** UTXOs created by the transaction — value that leaves to an address. */
  readonly outputs: readonly OfferedUtxo[]
  /**
   * Whether a zswap offer rides along.
   *
   * ⚠️ Opaque to this host by construction: a shielded offer's colours, amounts and recipients are
   * exactly what shielding hides, so it can never be checked against a declaration. It is a flag rather
   * than a list because there is nothing to list.
   */
  readonly shielded: boolean
}

/**
 * One entry per unshielded amount a transcript declared. `owner` is `undefined` for a declaration that
 * names a colour but no address.
 */
export type DeclaredUtxo = {readonly colour: string; readonly value: bigint; readonly owner: string | undefined}

/** What the calls in a transaction declared they would move. */
export type DeclaredValue = {
  /** `unshieldedInputs` — value the contract consumes, which the caller has to provide. */
  readonly inputs: readonly DeclaredUtxo[]
  /**
   * `claimedUnshieldedSpends` and `unshieldedOutputs` — value the contract authorises out.
   *
   * `claimedUnshieldedSpends` is keyed by `(colour, address)` and is the one the ledger's `well_formed`
   * check enforces against the offer, which is why a mint that omits its output fails there rather than
   * in the proof.
   */
  readonly outputs: readonly DeclaredUtxo[]
}

export type SponsorshipPolicy = {
  /**
   * `identity.compact`'s code digest: what makes a contract one of ours regardless of where it lands.
   *
   * ⚠️ Was an *address*, and could not stay one. There is one identity contract per identity now
   * (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1) and its address is derived from `C`, so no single address
   * exists to configure — a configured one would fund exactly one person's identity and refuse
   * everybody else's. The digest recognises the template, which is the property that was always doing
   * the work.
   */
  readonly identityCodeDigest: string
  /** Entry points we fund on any identity contract. */
  readonly identityEntryPoints: readonly string[]
  /**
   * `payment.compact`'s code digest — the permit contract, one global deployment.
   *
   * Recognised by code like everything else, even though this one *does* have a single address: a
   * digest survives the redeploy that a new circuit forces, and this contract has already moved once
   * for exactly that reason.
   */
  readonly paymentCodeDigest: string
  /** Entry points we fund on it. ⚠️ Never the admin ones — see {@link SPONSORED_PAYMENT_ENTRY_POINTS}. */
  readonly paymentEntryPoints: readonly string[]
  /** `handle.compact`'s code digest — one contract per claimed name, so there is no address to list. */
  readonly handleCodeDigest: string
  readonly handleEntryPoints: readonly string[]
  /**
   * `circle.compact`'s code digest: what makes a contract one of ours regardless of where it lands.
   *
   * A recompile changes it, which is correct — a circle deployed from a different template is a
   * different contract, and the device would not be able to prove against it either.
   */
  readonly circleCodeDigest: string
  /** Entry points we fund on any circle. */
  readonly circleEntryPoints: readonly string[]
  /**
   * `proposal.compact`'s code digest — one contract per proposal, so there is no address to list.
   *
   * ⚠️ **Separate from `circleCodeDigest`, and that is the whole point of this field existing.** The
   * 2026-08-25 split moved voting out of `circle.compact` into its own contract with its own digest;
   * until 2026-09-10 `castVote` and `revealVote` were listed under the circle's entry points, where
   * they funded nothing, and a proposal *deploy* matched no template at all.
   */
  readonly proposalCodeDigest: string
  /** Entry points we fund on any proposal. */
  readonly proposalEntryPoints: readonly string[]
  /**
   * Whether this sponsor funds a **plain transfer** — a transaction with no contract action at all.
   *
   * Off unless configured. It exists because a phone cannot pay a Midnight fee without first syncing
   * DUST (>1.2M events on preprod), while the fee is attached by a *separate* balancing transaction
   * and an unshielded signature covers only its own intent — so a sponsor can pay for a send it did
   * not author, and the wallet SDK's `transferTransaction` has a `payFees` flag for exactly that.
   *
   * ⚠️ It is a wider promise than the contract clauses: those recognise *our* contracts, whereas this
   * funds any send the caller authenticated for. The bound has to come from the caller — session auth
   * and a rate limit — not from the bytes, because a transfer carries nothing that identifies it as
   * ours. `docs/ABUSE_MITIGATION.md`.
   */
  readonly fundTransfers: boolean
}

/**
 * Which of our contracts a called address is, or `undefined` for one we do not recognise.
 *
 * Passed in rather than looked up here because recognising a circle needs the chain: its address is
 * derived from arguments this host never sees, so the only way to know is to read the contract's
 * `operations` and hash them. Keeping that out of the policy is what lets every branch below be
 * exercised without an indexer.
 */
export type ContractRecogniser = (address: string) => ContractKind | undefined

/** Refusal reason, or `undefined` when the transaction is one we are willing to fund. */
export type SponsorshipRefusal = string | undefined

/**
 * The prefix every thrown refusal carries.
 *
 * Exported so the HTTP layer can classify without re-matching the string. A refusal is the *caller's*
 * fault — malformed bytes, a contract this sponsor does not pay for, a replay — so it has to answer 4xx.
 * Answering 5xx is not merely imprecise: Cloudflare replaces the body of a 5xx coming from an origin with
 * its own error page, so the reason never reaches the caller at all.
 */
export const SPONSORSHIP_REFUSAL_PREFIX = 'sponsorship refused: '

/** Whether a thrown error is a sponsorship refusal rather than a genuine downstream failure. */
export const isSponsorshipRefusal = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(SPONSORSHIP_REFUSAL_PREFIX)

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Entry point names arrive as bytes or a string depending on the encoder. */
const nameOf = (entryPoint: unknown): string =>
  typeof entryPoint === 'string' ? entryPoint : new TextDecoder().decode(entryPoint as Uint8Array)

/** The minimum of `ContractState` this module reads — a deploy's initial state, or a queried one. */
export type ContractOperations = {
  operations(): (string | Uint8Array)[]
  operation(name: string | Uint8Array): {verifierKey: Uint8Array} | undefined
}

/**
 * A contract's code identity: SHA-256 over `name || sha256hex(verifierKey)` for every entry point, in
 * sorted name order.
 *
 * Byte-for-byte the digest `services/content/src/artifacts.ts` computes over the compiled
 * `keys/*.verifier` files — verified, not assumed: the keys the ledger carries in `operations` are the
 * same tagged bytes those files hold. That equality is the whole mechanism, because it means a value
 * published by the artifact service recognises a contract read off the chain.
 *
 * Sorted rather than declaration-ordered: `operations()` returns the map's iteration order, which is not
 * the contract's declaration order, and a digest that depended on it would differ per read.
 */
export const contractCodeDigest = (state: ContractOperations): string => {
  const names = state
    .operations()
    .map((entryPoint) => ({raw: entryPoint, name: nameOf(entryPoint)}))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const parts: Uint8Array[] = []
  const encoder = new TextEncoder()
  for (const {raw, name} of names) {
    const operation = state.operation(raw)
    if (operation === undefined) {
      throw new Error(`contract state lists entry point '${name}' but has no operation for it`)
    }
    parts.push(encoder.encode(name), encoder.encode(hex(sha256(operation.verifierKey))))
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return hex(sha256(joined))
}

/**
 * The policy decision, over already-decoded facts.
 *
 * Pure, so every branch is testable without constructing a real proven transaction — which needs a
 * device, a circuit and an SRS.
 */
export const sponsorshipRefusal = (
  tx: DecodedSponsoredTx,
  policy: SponsorshipPolicy,
  recognise: ContractRecogniser,
): SponsorshipRefusal => {
  // First, because an action we could not classify is the one thing we can say nothing else about.
  if (tx.otherActions > 0) {
    return `transaction contains ${tx.otherActions} action(s) that are neither a call nor a deploy`
  }
  const actions = tx.calls.length + tx.deploys.length
  if (actions === 0) {
    if (!policy.fundTransfers) {
      return 'transaction contains no contract call or deploy, so there is nothing for us to sponsor'
    }
    // A transfer is the only actionless transaction we fund, and it must actually be one: an empty
    // transaction, or one carrying only dust registrations, is not a send and buys the caller nothing
    // we meant to pay for.
    if (!tx.hasValueTransfer) {
      return 'transaction contains neither a contract action nor a transfer'
    }
    return undefined
  }
  // Exactly one: a batch would let a caller amortise many state changes onto one sponsored fee, and the
  // settlement ref the caller supplies describes a single action.
  if (actions > 1) {
    return `transaction contains ${actions} contract actions; the sponsor funds exactly one`
  }
  // Refused before the contract check: value riding *alongside* a contract action is never something we
  // fund — it amortises a transfer onto a sponsored state change — and saying so plainly beats
  // reporting it as an unrecognised-contract error. A transfer on its own is the `actions === 0` case
  // above, which `fundTransfers` governs.
  //
  // ⚠️ **Read against what the circuit declared, not against the offer's shape.** Shape was the
  // previous test — an offer moving value both ways was refused — and it was wrong about exactly the
  // transactions we mean to fund: a *paid* permit is payment in, permit out, which is both ways. So
  // every entry point selling one was listed as sponsored and could not be sponsored, the app's oldest
  // defect class. A payment is legitimate because the circuit asked for it, and a rider is illegitimate
  // because nothing declared it. See {@link undeclaredOffer}.
  if (tx.offer.shielded) {
    return 'transaction carries a shielded offer beside a contract action, which cannot be checked against what the call declared'
  }
  const undeclared = undeclaredOffer(tx.offer, tx.declared)
  if (undeclared !== undefined) {
    return `transaction offers ${undeclared}, which no contract action declared; the sponsor funds only the value a circuit asked for`
  }

  const deploy = tx.deploys[0]
  if (deploy !== undefined) {
    // Before the comparison, because an unset policy is the empty string and a value we failed to read
    // is too — so the two would match and fund a deploy nobody configured. The caller checks this as
    // well; this is the object that decides, so it does not delegate the check.
    const templates = [
      {kind: 'circle', digest: policy.circleCodeDigest},
      // A **proposal** deploy is funded because creating a proposal *is* a deploy — there is no
      // `createProposal` circuit and has not been since the split, so without this every proposal a
      // member writes is refused as an unrecognised template.
      {kind: 'proposal', digest: policy.proposalCodeDigest},
      {kind: 'identity', digest: policy.identityCodeDigest},
      // A **handle** deploy is funded because claiming a name *is* a deploy: the shell has to exist
      // before `bind` has anything to call. Payment is not in this list — it deploys once, by us, from
      // a funded wallet, and nothing a user does should ever pay for another one.
      {kind: 'handle', digest: policy.handleCodeDigest},
    ].filter((template) => template.digest !== '')
    if (templates.length === 0) {
      return 'this sponsor has no code digest configured, so it cannot recognise any deploy'
    }
    // Two templates rather than one because an identity's shell is now a deploy as well: it is the
    // first transaction a new identity makes, and refusing it would leave every new user unable to
    // publish a row at all.
    const matched = templates.find((template) => template.digest.toLowerCase() === deploy.codeDigest.toLowerCase())
    if (matched === undefined) {
      return `deploy at ${deploy.address} is not built from a template this sponsor funds (code ${deploy.codeDigest})`
    }
    if (!deploy.immutableAuthority) {
      return `deploy at ${deploy.address} carries a satisfiable maintenance authority, so its verifier keys could be replaced after we paid for it`
    }
    return undefined
  }

  const call = tx.calls[0] as {address: string; entryPoint: string}
  const kind = recognise(call.address)
  if (kind === undefined) {
    return `transaction targets contract ${call.address}, which is not deployed from a template this sponsor funds`
  }
  const allowed =
    kind === 'identity'
      ? policy.identityEntryPoints
      : kind === 'payment'
        ? policy.paymentEntryPoints
        : kind === 'handle'
          ? policy.handleEntryPoints
          : kind === 'proposal'
            ? policy.proposalEntryPoints
            : policy.circleEntryPoints
  if (!allowed.includes(call.entryPoint)) {
    return `entry point '${call.entryPoint}' is not sponsored on the ${kind} contract (allowed: ${allowed.join(', ')})`
  }
  return undefined
}

/**
 * The entry points the sponsor funds on `identity.compact`.
 *
 * ⚠️ **Renamed with the contract, not merely extended.** `claimName` / `releaseName` are gone: a name
 * is its own contract now (`handle.compact`) and the identity's own claim is `setPrimaryName`, while
 * `publishIdentityRow` became `publishRow`. The old list would have refused every transaction this app
 * can actually send, which is the failure mode a list of *strings* has — nothing compiles against it.
 *
 * `setRow` / `setRows` are the contact card. They are the one identity action a user repeats, so they
 * are also the ones worth noting for spend: each write is a caller-chosen 320-byte field, and the
 * sponsor pays for it. The circuit's asserts bound what can be written, not how often — that is the
 * rate limiter's job (`/register`), the same one publishing already leans on.
 */
export const SPONSORED_IDENTITY_ENTRY_POINTS: readonly string[] = ['publishRow', 'setPrimaryName', 'setRow', 'setRows']

/**
 * The entry points the sponsor funds on any circle.
 *
 * `join` and `setInvite` are what a gated circle needs end to end: someone has to be able to mint a
 * code, and someone has to be able to redeem it. Deliberately absent: `addModerator` and `setMember`
 * — moderator-gated, and funding a promotion or a ban is not something we pay for.
 *
 * ⚠️ **`leaveCircle` is funded, and it is the most tightly bounded entry here.** A leave needs a leaf
 * in `members`; leaves enter only by joining; an identity may join a circle once and, because nothing
 * releases the join nullifier, can never rejoin. So the same permanence that makes leaving one-way
 * caps the sponsor at **one leave per identity per circle** — a harder ceiling than `join`'s, which
 * this list already accepts. The alternative was worse than the spend: a member with no DUST who
 * cannot get out of a circle is trapped by a fee, which is not a property we want to ship.
 *
 * ⚠️ **`setInvite` is moderator-gated and funded anyway**, which is the one place this list departs
 * from "never the gated ones". The gate is in the circuit — only a persona already in `moderators`
 * can produce a valid proof — so what we are paying for is bounded by a set the founder controls,
 * and a gated circle whose founder cannot afford to mint a code is a feature that does not work.
 * Decided 2026-09-08, metered like `/register`, moving to founder-pays once preprod has indexer 4.4
 * (self-funded DUST is a torn read on 4.3).
 *
 * `issueInvite` and `setInviteAuthority` (added 2026-09-10) are the delegated-authority pair, and both
 * are gated in the circuit for the same reason `setInvite` is fundable: `issueInvite` needs the
 * `inviteAuthority` preimage, `setInviteAuthority` needs a leaf in `moderators`. Neither is reachable
 * by a stranger, and leaving them out would fund half a gated circle — a founder able to mint codes
 * by hand but unable to delegate, and an attestor unable to answer anyone.
 *
 * ⚠️ **`issueInvite` is the one entry point here the *service* calls, not a device.** What bounds it is
 * the delegation itself: one authority per circle, set and withdrawable by its moderators, so a
 * founder who stops trusting the attestor ends the spend with one `setInviteAuthority(zero)`.
 *
 * ⚠️ `join` covers **both** an open join and an invited one — `circle.compact` merged them, so this
 * entry alone no longer distinguishes the two. Nothing here needs to change for the gated arm.
 *
 * ⚠️ **`createProposal`, `castVote` and `revealVote` were removed on 2026-09-10 — they were never
 * reachable.** The 2026-08-25 split moved voting to `proposal.compact`, a different contract with a
 * different digest, and turned proposal creation into a *deploy*; `createProposal` has not existed
 * as a circuit since. Naming them here funded nothing and made voting look funded to anyone who
 * checked. The proposal contract still has **no** policy at all — no digest in the deploy templates,
 * no entry-point list — so both halves of the vote milestone are refused today. That is a real gap,
 * tracked in `docs/FOLLOW_UPS.md`, and it wants the same sponsor-host deploy as this change.
 */
export const SPONSORED_CIRCLE_ENTRY_POINTS: readonly string[] = [
  'join',
  'leaveCircle',
  'setInvite',
  'issueInvite',
  'setInviteAuthority',
]

/**
 * The entry points the sponsor funds on `proposal.compact`.
 *
 * Both of them, because a vote is two transactions by construction: `castVote` seals the ballot and
 * `revealVote` counts it, and funding only the first would leave every voter with a sealed vote they
 * cannot open. The deploy is funded separately, above — creating a proposal is a deploy.
 *
 * Both are gated in the circuit on a members-root proof against the root the proposal sealed, so a
 * stranger cannot produce a valid proof for either.
 */
export const SPONSORED_PROPOSAL_ENTRY_POINTS: readonly string[] = ['castVote', 'revealVote']

/**
 * The entry points the sponsor funds on `payment.compact`.
 *
 * ⚠️ **The admin circuits are deliberately absent.** `setPrice`, `grantPermit`, `grantRebindPermit`,
 * `grantModeratePermit` and `rotateAdmin` are gated on `adminAuth`, so a stranger cannot produce a valid
 * proof for one — but funding them would still be paying for *our* operations out of the sponsor, and an
 * operator who holds the secret has a funded wallet anyway.
 *
 * `claimFreePermit` is the one a brand-new user needs: it has no admin gate, and its whole point is a
 * wallet with nothing in it — including no DUST, which is what the sponsor supplies.
 */
export const SPONSORED_PAYMENT_ENTRY_POINTS: readonly string[] = ['claimFreePermit', 'buyPermitUnshielded']

/**
 * ⚠️ **`buyPermitShielded` is deliberately absent.**
 *
 * A shielded purchase pays through a zswap offer, whose colours, amounts and recipients are exactly what
 * shielding hides — so it can never be checked against what the circuit declared, and
 * {@link sponsorshipRefusal} refuses a shielded offer beside a call for that reason. It was listed here
 * until 2026-08-26 and could not be sponsored; an entry point declared fundable that is not is this
 * app's oldest defect class, so the list stopped promising it rather than the refusal being softened.
 *
 * Nothing is lost: a wallet holding shielded value to spend can pay its own DUST fee, which is the case
 * the sponsor exists to cover the absence of.
 */

/**
 * The entry points the sponsor funds on a handle contract.
 *
 * `bind` is the claim. `rebind` is a transfer and spends a per-name capability we mint, so funding it
 * costs nothing a grant did not already authorise. ⚠️ `moderate` and `revoke` are moderator powers and
 * stay out until a moderator surface exists to call them from — a sponsored entry point nothing can
 * reach is a promise with no caller.
 */
export const SPONSORED_HANDLE_ENTRY_POINTS: readonly string[] = ['bind', 'rebind']

/** What a deploy is called where an entry point name would otherwise go (settlement mapping below). */
export const DEPLOY_ACTION = 'deploy'

/**
 * Which settlement kinds an action may claim.
 *
 * The caller supplies a `ref` describing what to settle, and the transaction says what actually happens.
 * Cross-checking them stops a cheap action being submitted under an expensive action's ref (and vice
 * versa), which is what a budget keyed on action type would otherwise be trivially fooled by.
 * `publishIdentityRow` settles nothing — the row is not content-plane state.
 *
 * `deploy` replaced `createCircle`: creating a circle is no longer a call, so there is no entry point
 * to name.
 */
export const SETTLEMENT_KINDS_FOR_ACTION: Readonly<Record<string, readonly string[]>> = {
  // ⚠️ **Both**, because creating a proposal IS a deploy. There is no `createProposal` circuit and
  // has not been since the 2026-08-25 split, so a proposal arrives here as a deploy settling a
  // `proposal` ref. `['circle']` alone would refuse every proposal ever created.
  [DEPLOY_ACTION]: ['circle', 'proposal'],
  join: ['membership'],
  castVote: ['vote'],
  revealVote: ['vote'],
  publishIdentityRow: [],
  // Naming settles nothing either: a handle lives in the identity contract, not the content plane.
  claimName: [],
  releaseName: [],
  // The moderator/authority circuits. `setInvite` and `issueInvite` both confirm a commitment in the
  // circle's invites set; `setInviteAuthority` settles nothing, like `publishIdentityRow` — the
  // delegation lives in a ledger cell and the chain is its only record.
  setInvite: ['invite'],
  issueInvite: ['invite'],
  // ⚠️ It settles the `invite-authority` ref — this said `[]` ("settles nothing") while the app has
  // always submitted it under that kind, so enabling the check would have refused every delegation.
  // The ledger cell is the authority's only record, but the CONTENT ref still flips.
  setInviteAuthority: ['invite-authority'],
}

// ⚠️ **`settlementMismatch` has no production caller.** It is exported, tested, and never invoked, so
// an action submitted under another action's ref is accepted today. Tracked in `docs/FOLLOW_UPS.md`.
//
// ⚠️ **This previously claimed the map was "kept correct so wiring it up is a one-line change rather
// than an audit". It was not kept correct**, and verifying that on 2026-09-12 is the only reason the
// two entries above are right now: a proposal deploy and every `setInviteAuthority` would have been
// refused the moment the check went live. A map nothing consults cannot be trusted by reading it —
// which is the argument for wiring it, not against.
//
// What the wiring costs, measured rather than guessed: the settlement reaches
// `services/content/src/sponsor.ts`, which calls `client.submitProven(txBytes)` with `settlement`
// in scope one line above. So it is that argument, the matching parameter here, and the policy
// call — plus **a sponsor-host redeploy**, since this code runs there and not in the Worker.
// `settlement-mapping.test.ts` pins the pairs so the map cannot drift again while unused.

/** Why this action may not settle this ref kind, or `undefined` when the pair is coherent. */
export const settlementMismatch = (action: string, kind: string): SponsorshipRefusal => {
  const allowed = SETTLEMENT_KINDS_FOR_ACTION[action]
  if (allowed === undefined) {
    return `action '${action}' has no settlement mapping`
  }
  return allowed.includes(kind)
    ? undefined
    : `a '${action}' transaction cannot settle a '${kind}' ref (expected: ${
        allowed.length === 0 ? 'none' : allowed.join(', ')
      })`
}

/**
 * Transactions already accepted, so one valid proof cannot be resubmitted to burn fees repeatedly.
 *
 * This is not belt-and-braces. A proven transaction that **fails at the node** still costs a balance and a
 * submit, so without dedup a single accepted proof is an unbounded DUST drain — the cheapest attack on
 * the list and the one an allowlist does nothing about.
 *
 * In-memory and bounded: the sponsor is a single long-lived process, and the window that matters is
 * "recently", not "ever" — an old proof is stale against current contract state and fails on its own.
 */
export const createTxDeduplicator = (options: {readonly capacity?: number} = {}) => {
  const capacity = options.capacity ?? 10_000
  const seen = new Set<string>()
  const order: string[] = []
  return {
    /** `true` when this hash is new (and now remembered); `false` when it has been seen. */
    accept: (hash: string): boolean => {
      if (seen.has(hash)) return false
      seen.add(hash)
      order.push(hash)
      // FIFO eviction: unbounded growth would be its own memory-exhaustion vector on a long-lived host.
      if (order.length > capacity) {
        const evicted = order.shift()
        if (evicted !== undefined) seen.delete(evicted)
      }
      return true
    },
    size: (): number => seen.size,
  }
}

/**
 * Read the policy-relevant facts out of proven transaction bytes.
 *
 * Mirrors how `scripts/dump-*-preimage.mts` walks a transaction: intents → actions → the calls and
 * deploys among them. Actions are told apart by shape, which is all the wasm bindings offer: a call
 * carries an `entryPoint`, a deploy an `initialState`. Anything else is counted, never dropped.
 *
 * `hasValueTransfer` reads the **offers**, which is where value lives: an intent's unshielded offer
 * (`mn_addr…` inputs and outputs) and the transaction's zswap offers. Dust actions are deliberately not
 * value — DUST is the fee token, and a caller attaching their own dust spend is paying, not moving
 * funds. Pinned against a real 557-byte preprod transfer built by `harness/unshielded-send-preprod.ts`,
 * which is the fixture this function waited on: until 2026-08-20 it returned a hardcoded `false` and the
 * policy clause was unreachable.
 */
type OfferLike = {inputs?: unknown[]; outputs?: unknown[]} | undefined

/** An unshielded offer that names any input or output is value moving, whichever section it sits in. */
const offerMovesValue = (offer: OfferLike): boolean =>
  offer !== undefined && ((offer.inputs?.length ?? 0) > 0 || (offer.outputs?.length ?? 0) > 0)

/**
 * The UTXOs on one side of an unshielded offer, as colour/value/owner triples.
 *
 * An entry whose colour or value cannot be read is kept with an empty colour and a value of zero rather
 * than dropped: a colour we cannot name matches no declaration, so it is refused — which is the right
 * way round for a decoder that does not understand something.
 */
const sideOf = (offer: OfferLike, side: 'inputs' | 'outputs'): OfferedUtxo[] => {
  const entries = side === 'inputs' ? offer?.inputs : offer?.outputs
  if (entries === undefined) return []
  return entries.map((entry) => {
    const utxo = entry as {type?: unknown; value?: unknown; owner?: unknown}
    return {
      colour: typeof utxo.type === 'string' ? utxo.type.toLowerCase() : '',
      value: typeof utxo.value === 'bigint' || typeof utxo.value === 'number' ? BigInt(utxo.value) : 0n,
      owner: typeof utxo.owner === 'string' ? utxo.owner.toLowerCase() : '',
    }
  })
}

/** A `TokenType` reduced to its hex colour, or `undefined` for dust and anything unreadable. */
const colourOf = (token: unknown): string | undefined => {
  const type = token as {tag?: unknown; raw?: unknown} | undefined
  if (type?.tag !== 'unshielded' && type?.tag !== 'shielded') return undefined
  return typeof type.raw === 'string' ? type.raw.toLowerCase() : undefined
}

/** A `PublicAddress` reduced to the address a user output would carry, or `undefined` for a contract. */
const userAddressOf = (address: unknown): string | undefined => {
  const target = address as {tag?: unknown; address?: unknown} | undefined
  if (target?.tag !== 'user') return undefined
  return typeof target.address === 'string' ? target.address.toLowerCase() : undefined
}

type EffectsLike = {
  unshieldedInputs?: unknown
  unshieldedOutputs?: unknown
  claimedUnshieldedSpends?: unknown
}

/**
 * The `(key, amount)` pairs of one effects map.
 *
 * `Map` is what the bindings declare and what `intents` really is at runtime, so it is the expected
 * shape; an array of pairs is accepted because it is the only other shape a map keyed by an *object*
 * can take, and guessing wrong here would silently find no declarations at all. Anything else yields
 * nothing, which refuses — the safe direction for a decoder that does not understand something.
 *
 * ⚠️ **Read off a populated transcript on 2026-08-26 only through the type declarations, not through
 * real bytes.** The midnight-js simulator path declares these maps *empty*
 * ([[receive-unshielded-is-ops-not-effects]]), and our own Rust builder is what writes them — so the
 * first paid permit is what confirms the runtime shape. It fails closed if this is wrong: the
 * declarations read as absent and the offer is refused.
 */
const entriesOf = (entries: unknown): Iterable<readonly [unknown, unknown]> => {
  if (entries instanceof Map) return entries
  if (Array.isArray(entries)) return entries.filter((pair): pair is [unknown, unknown] => Array.isArray(pair))
  return []
}

/** Every `(TokenType, amount)` pair in one effects map, as colour/value declarations. */
const declarationsOf = (entries: unknown): DeclaredUtxo[] => {
  const found: DeclaredUtxo[] = []
  for (const [token, amount] of entriesOf(entries)) {
    const colour = colourOf(token)
    if (colour === undefined || typeof amount !== 'bigint') continue
    found.push({colour, value: amount, owner: undefined})
  }
  return found
}

/**
 * Every `((TokenType, PublicAddress), amount)` pair, as colour/value/owner declarations.
 *
 * A declaration naming a *contract* address is dropped: it authorises value into another contract, not
 * out to a caller's address, so it can never cover an offer output an address holds.
 */
const addressedDeclarationsOf = (entries: unknown): DeclaredUtxo[] => {
  const found: DeclaredUtxo[] = []
  for (const [key, amount] of entriesOf(entries)) {
    if (!Array.isArray(key) || typeof amount !== 'bigint') continue
    const colour = colourOf(key[0])
    const owner = userAddressOf(key[1])
    if (colour === undefined || owner === undefined) continue
    found.push({colour, value: amount, owner})
  }
  return found
}

/** What one transcript declared it would move. */
const declaredBy = (transcript: unknown): DeclaredValue => {
  const effects = (transcript as {effects?: EffectsLike} | undefined)?.effects
  if (effects === undefined) return {inputs: [], outputs: []}
  return {
    inputs: declarationsOf(effects.unshieldedInputs),
    outputs: [
      ...addressedDeclarationsOf(effects.claimedUnshieldedSpends),
      ...declarationsOf(effects.unshieldedOutputs),
    ],
  }
}

const sumByColour = (items: readonly DeclaredUtxo[]): Map<string, bigint> => {
  const totals = new Map<string, bigint>()
  for (const item of items) totals.set(item.colour, (totals.get(item.colour) ?? 0n) + item.value)
  return totals
}

/**
 * The first offered value no contract action declared, described for a refusal — or `undefined` when
 * every offered amount is covered.
 *
 * **Why this is the sound test.** A contract's declaration is a *lower* bound as far as the ledger is
 * concerned: `well_formed` checks the declared spends are present, and the balance check makes the sums
 * add up, but neither stops a caller adding an input and a matching output of their own and riding on a
 * sponsored fee. Treating the declaration as an *upper* bound is what closes that, and it does so
 * without a list of which circuits receive and which mint — a list that would have to be exactly right
 * for ever to say something the transcript already says.
 *
 * Inputs are matched by colour, because `unshieldedInputs` names no address — the value is coming *from*
 * the caller and the contract does not care whose it was. Outputs prefer the address-specific
 * declaration (`claimedUnshieldedSpends`, which is keyed by `(colour, address)`) and fall back to a
 * colour-only one (`unshieldedOutputs`); the colour-only pool is **consumed** as it is spent across
 * recipients, so one authorised amount cannot cover two addresses.
 */
export const undeclaredOffer = (offer: OfferedValue, declared: DeclaredValue): string | undefined => {
  const allowedIn = sumByColour(declared.inputs)
  for (const [colour, value] of sumByColour(offer.inputs.map((u) => ({...u, owner: undefined})))) {
    const allowed = allowedIn.get(colour) ?? 0n
    if (value > allowed) return `${value} in of ${describeColour(colour)} against ${allowed} declared`
  }

  const addressed = new Map<string, bigint>()
  for (const item of declared.outputs) {
    if (item.owner === undefined) continue
    const key = `${item.colour}\u0000${item.owner}`
    addressed.set(key, (addressed.get(key) ?? 0n) + item.value)
  }
  const anyOwner = sumByColour(declared.outputs.filter((item) => item.owner === undefined))

  const outgoing = new Map<string, {colour: string; owner: string; value: bigint}>()
  for (const utxo of offer.outputs) {
    const key = `${utxo.colour}\u0000${utxo.owner}`
    const held = outgoing.get(key)
    outgoing.set(key, {colour: utxo.colour, owner: utxo.owner, value: (held?.value ?? 0n) + utxo.value})
  }
  for (const [key, out] of outgoing) {
    let owed = out.value - (addressed.get(key) ?? 0n)
    if (owed <= 0n) continue
    // Spend from the colour-only pool, and take it out of the pool: two recipients must not each claim
    // the same authorised amount.
    const pool = anyOwner.get(out.colour) ?? 0n
    const taken = pool < owed ? pool : owed
    anyOwner.set(out.colour, pool - taken)
    owed -= taken
    if (owed > 0n) return `${owed} out of ${describeColour(out.colour)} against nothing declared`
  }
  return undefined
}

/** A colour for a refusal message. An unreadable one is named as such rather than shown as empty. */
const describeColour = (colour: string): string => (colour === '' ? 'an unreadable token type' : colour)

export const decodeSponsoredTx = (
  txBytes: Uint8Array,
  deserialize: (bytes: Uint8Array) => unknown,
): DecodedSponsoredTx => {
  const tx = deserialize(txBytes) as {
    intents?:
      | Map<unknown, {actions?: unknown[]; guaranteedUnshieldedOffer?: OfferLike; fallibleUnshieldedOffer?: OfferLike}>
      | undefined
    guaranteedOffer?: unknown
    fallibleOffer?: {size?: number} | undefined
  }
  const intents = tx.intents
  // Shielded value counts too: a zswap offer is value moving even though this host cannot see whose.
  const shielded = tx.guaranteedOffer !== undefined || (tx.fallibleOffer?.size ?? 0) > 0
  let hasValueTransfer = shielded
  const offerInputs: OfferedUtxo[] = []
  const offerOutputs: OfferedUtxo[] = []
  const declaredInputs: DeclaredUtxo[] = []
  const declaredOutputs: DeclaredUtxo[] = []
  const calls: {address: string; entryPoint: string}[] = []
  const deploys: DecodedDeploy[] = []
  let otherActions = 0
  if (intents !== undefined) {
    for (const intent of intents.values()) {
      if (offerMovesValue(intent.guaranteedUnshieldedOffer) || offerMovesValue(intent.fallibleUnshieldedOffer)) {
        hasValueTransfer = true
      }
      for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
        offerInputs.push(...sideOf(offer, 'inputs'))
        offerOutputs.push(...sideOf(offer, 'outputs'))
      }
      for (const action of intent.actions ?? []) {
        const candidate = action as {
          address?: unknown
          entryPoint?: unknown
          guaranteedTranscript?: unknown
          fallibleTranscript?: unknown
          initialState?: ContractOperations & {
            maintenanceAuthority?: {committee?: unknown[]; threshold?: number | bigint}
          }
        }
        if (typeof candidate.address !== 'string') {
          otherActions += 1
          continue
        }
        if (candidate.entryPoint !== undefined) {
          calls.push({address: candidate.address, entryPoint: nameOf(candidate.entryPoint)})
          // Both segments, summed: a call's inputs are declared where its work is, and a paid permit
          // does the spending in the fallible one ([[night-inputs-must-be-fallible]]).
          for (const transcript of [candidate.guaranteedTranscript, candidate.fallibleTranscript]) {
            const declared = declaredBy(transcript)
            declaredInputs.push(...declared.inputs)
            declaredOutputs.push(...declared.outputs)
          }
          continue
        }
        const state = candidate.initialState
        if (state === undefined) {
          otherActions += 1
          continue
        }
        const authority = state.maintenanceAuthority
        deploys.push({
          address: candidate.address,
          codeDigest: contractCodeDigest(state),
          // Empty committee with a non-zero threshold: a maintenance update's every signature index must
          // resolve against the committee, and zero signatures never reach the threshold. Read
          // defensively — an authority we cannot read is one we must not call unsatisfiable.
          immutableAuthority:
            Array.isArray(authority?.committee) &&
            authority.committee.length === 0 &&
            authority.threshold !== undefined &&
            BigInt(authority.threshold) > 0n,
        })
      }
    }
  }
  return {
    calls,
    deploys,
    otherActions,
    hasValueTransfer,
    offer: {inputs: offerInputs, outputs: offerOutputs, shielded},
    declared: {inputs: declaredInputs, outputs: declaredOutputs},
  }
}
