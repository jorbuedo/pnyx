/**
 * On-device proving of forum actions — the client half of the phase-B rail.
 *
 * Given the session's `forumRoot` (the seed-derived anonymous-identity master, cached at sign-in),
 * this derives the per-circle persona, fetches + caches the circuit artifacts, executes the circuit
 * against the live on-chain state, builds a proven-unbound transaction NATIVELY (the witness never
 * leaves the device), and POSTs it to the content service's `/chain/submit` — where the sponsor
 * wallet balances the DUST fee and submits it. The service settles the referenced ChainRef
 * asynchronously (pending → confirmed/failed).
 *
 * This is the reusable core the forum actions call when the `deviceProving` flag is on, replacing
 * the interim server-side `callTx` mirror (which derived the persona from `PERSONA_SECRET`).
 */

import {identityJoinNullifier, inviteCommitment, personaCommitment} from '@pnyx/contract-client/circle-derivations'
import {circleIdFromContentId, proposalContentFromContentId} from '@pnyx/contract-client/circle-id'
import {identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {moderatorAuthKeyPair, personaSkFromForumRoot} from '@pnyx/contract-client/persona'
import {
  buildCastVoteProvenTx,
  buildCircleDeployTx,
  buildJoinProvenTx,
  buildLeaveCircleProvenTx,
  buildProposalDeployTx,
  buildRevealVoteProvenTx,
  buildSetInviteAuthorityProvenTx,
  buildSetInviteProvenTx,
  circleDeployAddress,
  circleInviteAuthority,
  circleMemberPath,
  circleMembersRoot,
  circleModeratorPath,
} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {ballotRandomnessFor, storedBallotRandomness} from './ballot-randomness'
import {ensureCircleVerifierKeys, ensureCircuitArtifacts, ensureProposalVerifierKeys} from './pnyx-artifacts'
import {requireContractStateAt, requireContractStateAtHeight, requireTransactionHeight} from './pnyx-contract-state'
import {serviceUrl} from './pnyx-session'

/** The ChainRef a device-proven tx settles (matches the content service's `ProvenSettlement`). */
type SettlementRef =
  | {
      readonly kind: 'circle'
      readonly circleId: string
      readonly chainId: string
      /**
       * The persona commitment the constructor seats in `moderators` — this circle's whole on-chain
       * moderation authority, recorded so it is chain-anchored rather than inferred from a label.
       *
       * ⚠️ Sent for the **founder only**, never per member. Recording which session owns a *member*
       * leaf would mean handing the service `C` → persona commitment for everybody, which is the
       * linkage personas exist to prevent.
       */
      readonly founderLeaf: string
    }
  | {readonly kind: 'membership'; readonly circleId: string}
  /**
   * An invite whose commitment a moderator just published.
   *
   * The commitment rather than an id: the content plane has no row for an invite until this settles,
   * and the commitment is the only handle both sides already share. It is public — it is a ledger
   * key — so naming it here discloses nothing the chain does not.
   */
  | {readonly kind: 'invite'; readonly circleId: string; readonly commitment: string}
  /**
   * A founder delegating (or withdrawing) their circle's invite authority.
   *
   * Settles no row — the delegation lives in the contract's `inviteAuthority` cell and the chain is
   * its only record. `circleId` is here for the founder check at the route, not for a write: what it
   * bounds is whose circle the *sponsor* pays to delegate.
   */
  | {readonly kind: 'invite-authority'; readonly circleId: string}
  | {readonly kind: 'proposal'; readonly proposalId: string; readonly chainId: string}
  | {readonly kind: 'vote'; readonly proposalId: string}
  /**
   * The caller's own value transfer. No ids: there is no content-plane row to settle — the sponsor
   * balances the DUST fee and the chain is the record. Bounded by the session and a rate limit
   * (`docs/ABUSE_MITIGATION.md`), because a transfer's bytes carry nothing identifying them as ours.
   */
  | {readonly kind: 'transfer'}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const toHexString = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const ORIGIN = 'pnyx-proving'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4))
    out += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '='
    out += i + 2 < bytes.length ? B64.charAt(c & 63) : '='
  }
  return out
}

/**
 * The network id every builder here binds its transaction to, from `GET /auth/config`.
 *
 * The **only** thing this module needs from config. It used to demand the contract address too and
 * throw without one — a requirement that outlived its reason at the split: every circuit below
 * targets a circle, and a circle's address is derived from `(circleId, isOpen, founder)`, never
 * configured. Keeping the check would have made joining a circle fail on a deployment that simply
 * has no identity contract yet.
 */
const fetchChainNetwork = async (): Promise<string> => {
  const res = await fetch(`${serviceUrl()}/auth/config`)
  if (!res.ok) {
    throw new Error(`auth/config fetch failed: ${res.status}`)
  }
  const body = (await res.json()) as {network?: string}
  if (!body.network) {
    throw new Error('auth/config is missing network')
  }
  return body.network
}

/**
 * POST a proven-unbound tx to `/chain/submit`; throws unless the service accepts it (202).
 *
 * `network` names which Midnight network the bytes are for. The sponsor host holds **one wallet per
 * network**, so it is what decides which one balances them; omitted means "the host's default", which
 * is right for everything on the identity axis (see {@link submitSponsoredTransfer}).
 */
const postChainSubmit = async (
  token: string,
  tx: Uint8Array,
  ref: SettlementRef,
  network?: string,
): Promise<{readonly txId?: string}> => {
  const res = await fetch(`${serviceUrl()}/chain/submit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify({tx: toBase64(tx), ref, ...(network === undefined ? {} : {network})}),
  })
  if (res.status !== 202) {
    throw new Error(`/chain/submit rejected a device-proven ${ref.kind}: ${res.status} ${await res.text()}`)
  }
  // A transfer now comes back with where it landed, because the sponsor waits for it. Absent for
  // every other kind, which settles through a ChainRef row instead — and absent from a sponsor host
  // older than that change, which answers a bare 202. So this is read, never required.
  const text = await res.text()
  let txId: unknown
  try {
    txId = (JSON.parse(text) as {txId?: unknown}).txId
  } catch (e: unknown) {
    // `debug`, not `warn`: a 202 with no JSON body is the legacy sponsor answering, which is a
    // supported shape rather than a fault. Logged because "no id" and "unreadable answer" are
    // different facts and the first is the only one that should be quiet.
    logger.debug('the sponsor accepted without a readable body, so this submit has no tx id', {
      origin: 'pnyx-proving',
      kind: ref.kind,
      error: String(e),
    })
  }
  return typeof txId === 'string' && txId.length > 0 ? {txId} : {}
}

/**
 * Hand a signed, unbound Midnight transfer to the service for balancing and submission.
 *
 * The same route the forum actions use, with a settlement that settles nothing. Exported because a
 * wallet send is not a proving flow — nothing in this module builds it — but the submit contract
 * (base64, `ref`, 202-or-throw) is the same and must not be reimplemented beside it.
 *
 * ⚠️ **`network` is required here and absent everywhere else in this module, and that is the two-axis
 * rule** (`services/midnight/networks.ts`): every other settlement is a forum action on the **identity**
 * axis, which is the network the service itself was built for, so its own default is the right answer.
 * A transfer is on the **funds** axis — whichever network the in-app selector is on — and the service
 * cannot know it. Defaulting it here is exactly the mismatch that had a preview transfer accepted by the
 * preprod sponsor and refused inside `balanceTx` twenty minutes later.
 */
export const submitSponsoredTransfer = (
  token: string,
  tx: Uint8Array,
  network: string,
): Promise<{readonly txId?: string}> => postChainSubmit(token, tx, {kind: 'transfer'}, network)

/**
 * Poll a circle's on-chain ChainRef until the deploy confirms.
 *
 * It no longer returns an id: the circle's id and address are derived locally from the content id, so
 * there is nothing to learn from the service here beyond *whether the contract exists yet*. The join
 * has to wait for that, because it proves against the deployed contract's state.
 */
const waitForCircleConfirmed = async (token: string, contentCircleId: string, timeoutMs = 180_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${serviceUrl()}/circles/${contentCircleId}`, {headers: {authorization: `Bearer ${token}`}})
    if (res.ok) {
      const view = (await res.json()) as {circle?: {chain?: {status?: string; error?: string}}}
      const chain = view.circle?.chain
      if (chain?.status === 'confirmed') return
      if (chain?.status === 'failed') {
        throw new Error(`the circle deploy failed on-chain: ${chain.error ?? 'no reason given'}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('timed out waiting for the circle deploy to confirm before joining')
}

export type DeviceCircleParams = {
  readonly token: string
  readonly forumRoot: Uint8Array
  /** The content-plane circle id (settles this circle's ChainRef, and derives the on-chain id). */
  readonly contentCircleId: string
  /** Whether anyone may join without an invite. Part of the address, so it is fixed at creation. */
  readonly isOpen: boolean
}

/**
 * Deploy a circle's contract, then submit the creator's own `joinOpenCircle` against it.
 *
 * Creating a circle is a **deploy** now, not a circuit call, so the first transaction carries no
 * proof at all — a constructor is not a circuit. The device still builds it, because that is what
 * keeps the address a commitment to `(circleId, isOpen, founder)`: an SDK-built deploy randomises its
 * nonce, which would let whoever reports the address substitute a contract whose founder — and so
 * whose moderator seed — is not this creator (`docs/CONTRACT_MIGRATION.md`).
 *
 * The join still has to be on this rail: the creator's member leaf binds the persona derived from
 * their `forumRoot`, so a server-proved join would insert a leaf derived from `PERSONA_SECRET`
 * instead, and every later device-proved proposal or vote by the creator in their own circle would
 * fail to find its `memberPath`.
 *
 * Unlike the spike, the circle's id does not have to be waited for: it is derived from the
 * content-plane id, so the address is known before the deploy is even submitted. The join still waits
 * for confirmation, because it proves against the deployed contract's state.
 */
export const submitDeviceCircle = async (params: DeviceCircleParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const circleId = circleIdFromContentId(params.contentCircleId)
  const personaSk = personaSkFromForumRoot(params.forumRoot, circleId)
  // The founder leaf goes into `moderators`, not `members`: this is the circle's moderation authority
  // for its whole life, and it is this creator's per-circle persona.
  const founder = personaCommitment(personaSk)
  // The founder's request-signing key. Seated by the constructor because the founder is the circle's
  // only initial moderator and is not a member, so they could not promote themselves; without it the
  // one moderator a new circle has is one the content plane cannot authenticate.
  const founderAuth = moderatorAuthKeyPair(personaSk).publicKey
  // Seated in `joinedIdentities` beside the member leaf the constructor writes. Without it the founder
  // could `join` later and hold two leaves; with it, creating a circle is one transaction whether it
  // is open or gated, instead of deploy → self-invite → join.
  const founderJoined = identityJoinNullifier(circleId, identitySkFromForumRoot(params.forumRoot))
  // Every entry point's verifier key: they all feed the contract's address, so a partial set would
  // derive a different circle. Fetched by contract CODE, not by address — the contract does not exist
  // yet.
  const keysDir = await ensureCircleVerifierKeys()
  const deployArgs = {
    keysDir,
    circleId,
    isOpen: params.isOpen,
    founder,
    founderAuth,
    founderJoined,
  }
  const [tx, address] = await Promise.all([
    buildCircleDeployTx({...deployArgs, networkId: network, ttlSecs: Math.floor(Date.now() / 1000) + 3600}),
    circleDeployAddress(deployArgs),
  ])
  await postChainSubmit(params.token, tx, {
    kind: 'circle',
    circleId: params.contentCircleId,
    chainId: toHexString(address),
    founderLeaf: toHexString(founder),
  })

  // No join leg: the constructor seats the founder in `members` and spends their identity nullifier,
  // so the deploy *is* their join. The service settles their membership ChainRef from this same
  // settlement, because there is no second transaction to settle it.
  await waitForCircleConfirmed(params.token, params.contentCircleId)
}

export type DeviceJoinParams = {
  /** JWT for the authenticated session (the ChainRef the tx settles belongs to this subject). */
  readonly token: string
  /** Seed-derived anonymous-identity master (session-cached at sign-in). */
  readonly forumRoot: Uint8Array
  /** The content-plane circle id (settles this circle's membership ChainRef). */
  readonly contentCircleId: string
  /** The circle's 32-byte on-chain id — `circleIdFromContentId`, and part of its address. */
  readonly chainCircleId: Uint8Array
  /** The circle's own contract address (hex). There is no single forum contract any more. */
  readonly circleContractAddress: string
  /**
   * The invite secret to redeem, or absent for an open circle.
   *
   * Single-use by absence: joining removes the commitment from the contract's `invites`, so the same
   * secret cannot be redeemed twice and a replayer needs the secret rather than the commitment.
   */
  readonly inviteSecret?: Uint8Array | undefined
}

/**
 * Build + submit an on-device-proven `joinOpenCircle` for the given circle. Resolves once the
 * service has accepted the transaction for submission (HTTP 202); the on-chain landing is reported
 * asynchronously via the membership ChainRef. Throws on any build/network failure.
 */
export const submitDeviceJoin = async (params: DeviceJoinParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  // The join nullifier is keyed on the ACCOUNT identity secret, not the persona: that is what makes
  // one join per identity hold against a client inventing extra personas. Derived here from the same
  // cached `forumRoot` rather than threaded through every caller, since it is not circle-specific.
  const identitySk = identitySkFromForumRoot(params.forumRoot)
  const [paths, contractState] = await Promise.all([
    ensureCircuitArtifacts('join', 'circle'),
    requireContractStateAt(params.circleContractAddress),
  ])
  const tx = await buildJoinProvenTx(paths, {
    contractState,
    contractAddress: fromHex(params.circleContractAddress),
    circleId: params.chainCircleId,
    // Absent joins an open circle. A gated one needs the secret whose commitment a moderator
    // published, and the two build different transcripts — so this is not a hint the builder can
    // ignore, it selects the arm.
    ...(params.inviteSecret === undefined ? {} : {inviteSecret: params.inviteSecret}),
    identitySk,
    personaSk,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {kind: 'membership', circleId: params.contentCircleId})
}

export type DeviceLeaveParams = {
  /** JWT for the authenticated session. */
  readonly token: string
  /** Seed-derived anonymous-identity master (session-cached at sign-in). */
  readonly forumRoot: Uint8Array
  /** The content-plane circle id, so the settlement names the row this belongs to. */
  readonly contentCircleId: string
  /** The circle's 32-byte on-chain id — derives this member's persona. */
  readonly chainCircleId: Uint8Array
  /** The circle's own contract address (hex). */
  readonly circleContractAddress: string
}

/**
 * Build + submit an on-device-proven `leaveCircle` — blank this persona's own leaf in `members`.
 *
 * ⚠️ **One-way, and the caller must have said so already.** `join` asserts against
 * `joinedIdentities` and nothing ever removes from that set, so this identity can never rejoin this
 * circle — not with a fresh invite, not if a moderator wants them back. The refusal surfaces far
 * from here, at a later `join`, as "identity already joined". That set is what makes a ban
 * permanent; leaving reuses the removal and inherits the property.
 *
 * The path is read from the circle's own state rather than passed in: a circle holds its trees,
 * unlike a proposal, and a path computed against anything but the state this transcript runs on is a
 * root that matches nothing. A persona with no leaf fails here, in the path read, rather than as an
 * unsatisfiable constraint several layers down.
 */
export const submitDeviceLeave = async (params: DeviceLeaveParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const leaf = personaCommitment(personaSk)
  const [paths, contractState] = await Promise.all([
    ensureCircuitArtifacts('leaveCircle', 'circle'),
    requireContractStateAt(params.circleContractAddress),
  ])
  // ⚠️ 20 × 33 bytes — a member path, not the 10 × 33 the moderator-gated circuits take.
  const memberPath = await circleMemberPath({contractState, leaf})
  const tx = await buildLeaveCircleProvenTx({
    ...paths,
    contractState,
    contractAddress: fromHex(params.circleContractAddress),
    personaSk,
    memberPath,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {kind: 'membership', circleId: params.contentCircleId})
}

export type DeviceSetInviteParams = {
  readonly token: string
  readonly forumRoot: Uint8Array
  /** The content-plane circle id, so the settlement can name the row this belongs to. */
  readonly contentCircleId: string
  /** The circle's 32-byte on-chain id — derives this moderator's persona. */
  readonly chainCircleId: Uint8Array
  /** The circle's own contract address (hex). */
  readonly circleContractAddress: string
  /**
   * The 32-byte invite secret. **The capability itself** — whoever holds it can join once.
   *
   * Generated by the caller rather than here so the caller owns its lifetime: it has to survive
   * this call to be shown or handed to an attestor, and a secret this function minted and returned
   * would be one more copy to lose track of.
   */
  readonly secret: Uint8Array
  /** `false` revokes a previously published commitment; the circuit asserts it is present. */
  readonly active?: boolean
}

/**
 * Publish (or withdraw) a circle invite, proved on this device.
 *
 * ⚠️ **This is the leg that did not exist**, and its absence is why a founder could create a gated
 * circle and never mint a code for it. Every other piece was built — `set_invite_prototype` in Rust,
 * the builder on all four bridge layers, `setInvite` artifacts published at the current digest — and
 * the one missing link was `circleModeratorPath`: the builder took a moderator path that nothing
 * above Rust could compute.
 *
 * ⚠️ **The chain stores the commitment, never the secret.** `inviteCommitment(secret)` is a one-way
 * hash, so an invite cannot be recovered from the ledger by us or by anyone — the secret has to be
 * kept by whoever will hand it out, and shown to its recipient once.
 *
 * `setInvite` is sponsored (`SPONSORED_CIRCLE_ENTRY_POINTS`): the gate is in the circuit, so what is
 * paid for is bounded by a moderator set the founder controls.
 */
export const submitDeviceSetInvite = async (params: DeviceSetInviteParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const leaf = personaCommitment(personaSk)
  const [paths, contractState] = await Promise.all([
    ensureCircuitArtifacts('setInvite', 'circle'),
    requireContractStateAt(params.circleContractAddress),
  ])
  // ⚠️ 10 × 33 bytes, not the 20 × 33 a member path is. The circuit reports the wrong one as
  // "not a moderator", which names neither the depth nor the tree.
  const moderatorPath = await circleModeratorPath({contractState, leaf})
  const commitment = inviteCommitment(params.secret)
  const tx = await buildSetInviteProvenTx({
    ...paths,
    contractState,
    contractAddress: fromHex(params.circleContractAddress),
    personaSk,
    moderatorPath,
    commitment,
    active: params.active ?? true,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {
    kind: 'invite',
    circleId: params.contentCircleId,
    commitment: toHexString(commitment),
  })
}

/**
 * Delegate this circle's invite issuance to a commitment, rotate it, or withdraw it.
 *
 * ⚠️ **This is not `addModerator` and must never become it.** The obvious way to let a service issue
 * invites is to promote it, and it is wrong twice over: `moderators` is insert-only, so the grant
 * would be permanent for the life of the circle, and a moderator can also ban any member and seat any
 * persona. `inviteAuthority` is the least privilege that does the job — insert and remove in
 * `invites`, nothing else — and it is revocable, which is the property a moderator grant cannot have.
 *
 * Pass **32 zero bytes** as `authority` to withdraw. That is one transaction and it ends the
 * delegation outright.
 */
export const submitDeviceSetInviteAuthority = async (params: {
  readonly token: string
  readonly forumRoot: Uint8Array
  readonly contentCircleId: string
  readonly chainCircleId: Uint8Array
  readonly circleContractAddress: string
  /** `inviteAuthorityCommitment(sk)` of the new delegate, or 32 zero bytes to withdraw. */
  readonly authority: Uint8Array
}): Promise<void> => {
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const leaf = personaCommitment(personaSk)
  const [paths, contractState] = await Promise.all([
    ensureCircuitArtifacts('setInviteAuthority', 'circle'),
    requireContractStateAt(params.circleContractAddress),
  ])
  // ⚠️ 10 × 33 bytes, not the 20 × 33 a member path is. The circuit reports the wrong one as
  // "not a moderator", which names neither the depth nor the tree.
  const moderatorPath = await circleModeratorPath({contractState, leaf})
  const tx = await buildSetInviteAuthorityProvenTx({
    ...paths,
    contractState,
    contractAddress: fromHex(params.circleContractAddress),
    personaSk,
    moderatorPath,
    authority: params.authority,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {kind: 'invite-authority', circleId: params.contentCircleId})
}

/**
 * Who this circle has delegated invite issuance to, straight off its contract state.
 *
 * ⚠️ **The chain is the only source, and that is why this exists rather than a field on the API
 * response.** The content plane caches the commitment it *would* use; whether the circle accepted it
 * is a fact about the contract's `inviteAuthority` cell and nothing else. A control that read the
 * cache would tell a founder delegation was on when they never made the call — or still on after
 * they withdrew it.
 *
 * `undefined` means "delegated to nobody". A read failure throws, deliberately: the two must not
 * render the same, or a founder is invited to redo a delegation that is already live.
 */
export const readCircleInviteAuthority = async (circleContractAddress: string): Promise<Uint8Array | undefined> =>
  circleInviteAuthority(await requireContractStateAt(circleContractAddress))

export type DeviceProposalParams = {
  readonly token: string
  readonly forumRoot: Uint8Array
  /** The proposal's circle's 32-byte on-chain id (for the persona + membership witness). */
  readonly chainCircleId: Uint8Array
  /** The circle's own contract address (hex). */
  readonly circleContractAddress: string
  /** The content-plane proposal id (settles this proposal's ChainRef, and derives the address). */
  readonly contentProposalId: string
  /**
   * How many options this ballot carries — sealed into the contract and into its address.
   *
   * Required rather than defaulted to 2: `proposal.compact` seeds `tallies` for exactly this many
   * options in its constructor and `revealVote` range-checks against it, so a wrong count is a ballot
   * whose extra options can never be counted. The contract accepts 2..8.
   */
  readonly optionCount: number
}

/**
 * Raised by the two on-chain poll legs, which the circle split left without a rail.
 *
 * A distinct error rather than a generic one so a caller can tell "this feature is not built" apart from
 * "the chain refused it" — the content-plane poll succeeded either way, and reporting a chain failure as
 * a poll failure would be wrong.
 */
export class ProposalRailUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposalRailUnavailableError'
  }
}

/**
 * Deploy a proposal's contract.
 *
 * **A proposal is a deploy, not a call** (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10). `createProposal`
 * stopped existing as a circuit at the split, which is what stops two authors conflicting: the address
 * is a hash over the initial state plus `persistentHash(["pnyx:proposal", circleId, content])`, so the
 * id *is* the content commitment and there is no counter to race for. Like the circle deploy this
 * carries **no circuit proof** — a constructor is not a circuit — so the device builds it and the
 * sponsor pays for it.
 *
 * ⚠️ **The electorate is read here, once, and frozen.** `membersRoot` comes from the circle's *live*
 * state at this moment and is sealed into the contract, so a ban afterwards does not disenfranchise and
 * a join afterwards does not enfranchise. That is the snapshot the design chose deliberately, and it is
 * why the root is read at creation rather than at vote time. A voter later proves a path against this
 * exact root — see `circleMembersRoot`, whose whole purpose is letting a client compare before proving.
 *
 * ⚠️ **The author persona is disclosed, and that is deliberate**: it is the circle pseudonym, and a
 * moderator has to be able to name what they ban. It stays unlinkable to `C` and to this persona's own
 * votes, which are keyed on the same secret under different tags.
 */
export const submitDeviceProposal = async (params: DeviceProposalParams): Promise<void> => {
  if (!Number.isInteger(params.optionCount) || params.optionCount < 2 || params.optionCount > 8) {
    // Refused here rather than at the constructor's `assert`, which would surface as a rejected
    // transaction minutes later with no mention of the option count.
    throw new ProposalRailUnavailableError(`a ballot needs between 2 and 8 options, not ${String(params.optionCount)}`)
  }
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const author = personaCommitment(personaSk)
  const content = proposalContentFromContentId(params.contentProposalId)
  const [keysDir, circleState] = await Promise.all([
    ensureProposalVerifierKeys(),
    requireContractStateAt(params.circleContractAddress),
  ])
  // The circle's tree as it stands now. Read from the contract rather than from the content plane:
  // the root is what every future vote proves against, so it has to be the chain's own answer.
  const membersRoot = await circleMembersRoot(circleState)
  const deployArgs = {
    keysDir,
    circleId: params.chainCircleId,
    membersRoot,
    content,
    author,
    optionCount: params.optionCount,
  }
  const {address, tx} = await buildProposalDeployTx({
    ...deployArgs,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {
    kind: 'proposal',
    proposalId: params.contentProposalId,
    chainId: toHexString(address),
  })
}

// The vote-confirmation poller lived here: `revealVote` had to be built against the post-commit
// state, so it waited for `castVote` to confirm first. Removed with the vote rail — the wait is
// still required when it is rebuilt, and that is the reason worth keeping rather than the code.

export type DeviceVoteParams = {
  readonly token: string
  readonly forumRoot: Uint8Array
  readonly contentCircleId: string
  /** The proposal's circle's 32-byte on-chain id (for the persona witness). */
  readonly chainCircleId: Uint8Array
  /** The circle's own contract address (hex) — where the electorate lives. */
  readonly circleContractAddress: string
  /** The proposal's own contract address (hex), from its `ChainRef.chainId`. */
  readonly proposalContractAddress: string
  /**
   * The proposal deploy's transaction hash, from its `ChainRef.txId`.
   *
   * This is what selects the electorate: the circle's members tree is read at the block this landed
   * in, not as it stands now. A `ChainRef` records no height, so the height is resolved from here.
   */
  readonly proposalDeployTxHash: string
  /** The content-plane proposal id (settles the vote ChainRef). */
  readonly contentProposalId: string
  readonly value: 'yes' | 'no'
}

/**
 * The ballot options, in the order `proposal.compact`'s constructor seeds its tallies.
 *
 * `optionCount` is 2 today (`CreatePollSheet`), and the contract range-checks the option against it
 * on reveal. This mapping is the only place the content plane's yes/no meets the contract's
 * `Uint<8>`, so a third option means changing it here and in the tally read together.
 */
const BALLOT_OPTIONS = {yes: 0, no: 1} as const

/**
 * Read the electorate the proposal sealed, and this persona's path through it.
 *
 * ⚠️ **The tree is read at the proposal's deploy height, not the current one.** `membersRoot` is a
 * sealed field: a join afterwards moves the live root, and a path read from the live tree then
 * satisfies nothing. `requireContractStateAtHeight` is the whole reason the indexer's
 * `contractAction(address, offset:)` argument is now plumbed through.
 *
 * The root comparison the design calls for — check the path's root against the proposal's sealed one
 * *before* proving, so a wrong height fails with a sentence — is **not** done here: nothing bridges a
 * read of the proposal's `membersRoot` cell to JS (`preimage.rs` reads it at slot 1, natively). The
 * circuit still enforces it, so a wrong path cannot produce a valid vote; what is missing is only the
 * better error, and buying it costs a native rebuild.
 */
const electorateFor = async (params: DeviceVoteParams, personaSk: Uint8Array): Promise<Uint8Array> => {
  const height = await requireTransactionHeight(params.proposalDeployTxHash)
  const circleState = await requireContractStateAtHeight(params.circleContractAddress, height)
  const leaf = personaCommitment(personaSk)
  const path = await circleMemberPath({contractState: circleState, leaf})
  logger.debug('read a member path as of the proposal’s electorate', {
    origin: ORIGIN,
    height,
    circle: params.circleContractAddress,
    proposal: params.proposalContractAddress,
  })
  return path
}

/**
 * Build + submit an on-device-proven `castVote` — the commit half of the ballot.
 *
 * Commit-reveal, so this moves no tally. It writes
 * `persistentCommit<Uint<8>>(ballotOption(), ballotRand())` against this persona's vote nullifier,
 * and {@link submitDeviceVoteReveal} opens it once this transaction has confirmed.
 *
 * ⚠️ **The randomness is stored before the transaction is submitted.** A commit whose randomness was
 * never written down can never be opened, and the tally never moves — so the write has to happen on
 * the losing side of a crash, not the winning one.
 */
export const submitDeviceVote = async (params: DeviceVoteParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const [paths, memberPath, proposalState] = await Promise.all([
    ensureCircuitArtifacts('castVote', 'proposal'),
    electorateFor(params, personaSk),
    requireContractStateAt(params.proposalContractAddress),
  ])
  const ballotRand = await ballotRandomnessFor(network, params.proposalContractAddress)
  const tx = await buildCastVoteProvenTx({
    ...paths,
    contractState: proposalState,
    contractAddress: fromHex(params.proposalContractAddress),
    personaSk,
    ballotOption: BALLOT_OPTIONS[params.value],
    ballotRand,
    memberPath,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {kind: 'vote', proposalId: params.contentProposalId})
}

/**
 * Build + submit an on-device-proven `revealVote` — the half that moves the tally.
 *
 * ⚠️ **Must run against state that already holds the commit.** `revealVote` asserts
 * `commits.lookup(nullifier) == persistentCommit(option, ballotRand())`, so the proposal state this
 * proves against has to be read *after* the cast has confirmed. A caller that reveals too early
 * fails on a lookup for a key that is not there yet.
 *
 * No member path: membership was proved at the commit, and re-proving it here would leak that the
 * same member is behind both transactions.
 */
export const submitDeviceVoteReveal = async (params: DeviceVoteParams): Promise<void> => {
  const network = await fetchChainNetwork()
  const ballotRand = await storedBallotRandomness(network, params.proposalContractAddress)
  if (ballotRand === undefined) {
    // Not an error state worth retrying: either the cast happened on another device, or the
    // randomness is gone and the commit is unopenable. Both need a person, not a retry.
    throw new ProposalRailUnavailableError(
      'this device did not cast the vote it is being asked to reveal, so it cannot open the commitment',
    )
  }
  const personaSk = personaSkFromForumRoot(params.forumRoot, params.chainCircleId)
  const [paths, proposalState] = await Promise.all([
    ensureCircuitArtifacts('revealVote', 'proposal'),
    requireContractStateAt(params.proposalContractAddress),
  ])
  const tx = await buildRevealVoteProvenTx({
    ...paths,
    contractState: proposalState,
    contractAddress: fromHex(params.proposalContractAddress),
    personaSk,
    ballotOption: BALLOT_OPTIONS[params.value],
    ballotRand,
    networkId: network,
    ttlSecs: Math.floor(Date.now() / 1000) + 3600,
  })
  await postChainSubmit(params.token, tx, {kind: 'vote', proposalId: params.contentProposalId})
}
