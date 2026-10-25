// Content store — the port that decided the content plane (spec §14 item 5). It earned its
// keep: the store behind it has already been swapped once without touching a consumer, and
// the production implementation is now `d1-store.ts` (Cloudflare D1, served by the Worker).
// This file's own implementation is in-memory maps with debounced JSON-file persistence,
// which is honest for a single-instance dev deployment and is what the Node server uses.
//
// Identity model (off-chain mirror of spec §4):
// - `subject` = the authenticated account (JWT `sub`). NEVER exposed in content reads.
// - `persona` = the per-circle display identity chosen at join time — either disclosed
//   (the subject itself) or a pseudonym. Authors on posts/proposals are persona labels;
//   the subject↔persona mapping stays server-side, so pseudonymous personas in different
//   circles are unlinkable through the API. On-chain this mapping disappears entirely
//   (member leaves + nullifiers); here the server is trusted with it — a documented
//   dev-mode trust gap, not the end state.
// - Vote-once is keyed by subject internally (the action-nullifier analogue).
import fs from 'node:fs';
import path from 'node:path';
import type { DmPolicy } from './dm-consent.js';
import type { DmRetentionOutcome, DmRetentionPolicy } from './dm-retention.js';
import { dmRetentionCutoffs } from './dm-retention.js';

/** Status of the on-chain mirror of an entity (absent = chain mirroring disabled). */
export type ChainRef = {
  readonly status: 'pending' | 'confirmed' | 'failed';
  readonly txId?: string;
  /**
   * What this entity is on chain — and the two kinds are not the same shape:
   *
   * - **circle**: its contract's 64-hex **address**. A circle is a contract now, so there is no
   *   counter to allocate from; the address is derived from `(circleId, isOpen, founder)` and the
   *   device knows it before the deploy is even submitted (`docs/CONTRACT_MIGRATION.md`).
   * - **proposal**: a decimal counter, still — `proposalCount` survives *inside* each circle
   *   contract, so proposal ids stay sequential and stay scoped to their circle for free.
   *
   * Membership and vote refs carry none: neither has an on-chain id, only a nullifier nobody can
   * link back to them.
   *
   * Kept as one `string` deliberately rather than split per kind: every consumer either echoes it
   * back to the client or hands it straight to a builder, and the entity it hangs off already says
   * which kind it is.
   */
  readonly chainId?: string;
  readonly error?: string;
};

export type Circle = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Persona label of the creator (never the subject). */
  readonly author: string;
  readonly createdAt: string;
  readonly memberCount: number;
  readonly chain?: ChainRef;
  /**
   * The persona commitment this circle's constructor seated in the on-chain `moderators` tree, hex.
   *
   * Absent for a circle settled before this was recorded, or one never settled on chain — which is a
   * different fact from "has no moderator", and readers must not collapse them.
   *
   * ⚠️ **This is the circle's whole on-chain moderation authority.** `addModerator` has no caller on
   * any rail, so the moderator set is exactly this leaf. It is recorded here — rather than a per-member
   * link table — because knowing which *session* owns a leaf would mean storing `C` → persona
   * commitment for every member, and that is the linkage the persona design exists to avoid.
   */
  readonly founderLeaf?: string;
  /**
   * The authenticated subject that settled this circle's contract, and so named its founder leaf.
   *
   * ⚠️ **Service-side only** — never in an API response, like every other subject. It is what channel
   * authority is gated on: only the creator can settle (see `resolveSettlement`), so this is whoever
   * actually put the circle on chain, rather than whoever holds a matching persona label.
   *
   * Absent for a circle settled before this shipped, or never settled — which falls back to the label
   * comparison rather than locking the circle's own creator out.
   */
  readonly founderSubject?: string;
  /**
   * What the rail shows for this circle — one grapheme, an emoji included.
   *
   * Absent means the founder has not chosen one and the rail uses the name's initial, which is what
   * every circle showed before this existed.
   */
  readonly displayChar?: string;
  /**
   * Whether anyone may join without an invite.
   *
   * Sealed into the contract's initial state and therefore into its address, so it is fixed at
   * creation and never edited here — the row records what the deploy already committed to. Discovery
   * needs it: a gated circle is not a place a stranger can enter, so listing one would be a promise
   * the UI cannot keep.
   */
  readonly isOpen: boolean;
  /**
   * The code digest of the contract this circle deployed — SHA-256 over its entry points' verifier
   * keys, the same value `sponsorship.ts` recognises our templates by.
   *
   * Absent means **not determined yet**, never "current". It is resolved the first time a settled
   * circle is read; a circle that never settled has no contract and so no digest.
   */
  readonly codeDigest?: string;
};

export type Membership = {
  readonly persona: string;
  readonly disclosed: boolean;
  readonly joinedAt: string;
  readonly chain?: ChainRef;
};

export type Proposal = {
  readonly id: string;
  readonly circleId: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly tally: { yes: number; no: number };
  readonly chain?: ChainRef;
};

export type Post = {
  readonly id: string;
  readonly circleId: string;
  /** Present on replies; must reference a post in the same circle. */
  readonly parentId?: string;
  /**
   * Which channel this post belongs to, or absent for the circle's default stream.
   *
   * ⚠️ Absent is a real answer, not a missing one: every post written before channels existed belongs
   * to the default stream, and putting them in a synthesised `#general` would invent a channel nobody
   * created.
   */
  readonly channelId?: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
};

/**
 * A named grouping of a circle's posts. **Content-layer only** — see `migrations/0007_channels.sql`.
 *
 * Threads are unrelated and already work: a reply carries {@link Post.parentId}, and the data model's
 * tree is arbitrary-depth. A channel groups top-level posts; it does not nest them.
 */
/**
 * A circle's self-service invite rule, as the row holds it.
 *
 * `kind` + one `param` rather than a typed union, because that is the column pair — the union is
 * `circle-invite-policy.ts`'s `InvitePredicate`, and parsing happens at the boundary so an
 * unreadable stored row is a 500 the route words rather than a type lie.
 */
export type StoredInvitePolicy = {
  /**
   * The circle's requirements — **any** of which admits a wallet (`accountSatisfiesAny`).
   *
   * Possibly empty, and that is a real state rather than a defect: a circle whose only rule was the
   * withdrawn `drep-any` kept its policy row and lost its rules in migration `0016`. Empty admits
   * nobody, which is what the routes report.
   */
  readonly rules: readonly { readonly kind: string; readonly param: string | null }[];
  /**
   * `inviteAuthorityCommitment(sk)` of the secret this deployment would issue this circle's invites
   * with — what the founder posts on chain with `setInviteAuthority` to turn self-service on.
   *
   * ⚠️ A **cache of what we would use**, never a record of what the circle granted. Only the contract's
   * `inviteAuthority` cell says whether the delegation is live, and only a chain read answers that; a
   * founder who set a policy and never made the call has a row here and a closed gate on chain.
   */
  readonly authorityCommitment: string | null;
  readonly updatedAt: string;
};

/** An invite already issued to one claimant, as this service recorded it. */
export type ClaimedInvite = {
  /** Hex of `inviteCommitment(secret)` — the ledger key. */
  readonly commitment: string;
  /** Hex of the 32-byte secret. **The capability**: whoever reads this joins the circle once. */
  readonly secret: string;
  /**
   * `'pending'` until the mint settles on chain.
   *
   * ⚠️ A pending code is never handed out as if it worked: its commitment is not in `invites` yet, so
   * a join with it fails as "no such invite" — indistinguishable, to the recipient, from being refused.
   */
  readonly chainStatus: string;
};

export type Channel = {
  readonly id: string;
  readonly circleId: string;
  readonly name: string;
  /**
   * What this channel is for, as its creator described it.
   *
   * Absent means they gave none — which the panel renders as nothing, rather than repeating the
   * default stream's line under a channel that has its own subject.
   */
  readonly description?: string;
  /** Persona label of the creator, never the subject. */
  readonly createdBy: string;
  readonly createdAt: string;
};

/**
 * A chain-mirror task whose transaction failed.
 *
 * ⚠️ Nothing re-enqueues these any more — the replay went with the server-proving rail, which is the
 * only thing that could rebuild such a transaction (see `chain.ts`). The rows are still recorded and
 * still readable, so `GET`ing them tells an operator what failed; they are just not automatically
 * retried. A device-proven action is retried from the device, which is the only place its witnesses
 * exist.
 */
export type ChainBacklogItem =
  | { kind: 'circle'; circleId: string }
  | { kind: 'membership'; circleId: string; subject: string }
  | { kind: 'proposal'; circleId: string; proposalId: string; authorSubject: string }
  | { kind: 'vote'; circleId: string; proposalId: string; subject: string; value: 'yes' | 'no' };

/** A push-notification device registration (POST /devices). */
export type Device = {
  readonly fcmToken: string;
  readonly platform: string;
  readonly registeredAt: string;
};

// ── Direct messages (docs/DIRECT_MESSAGES_PLAN.md phase 4) ──
//
// This is a DELIVERY layer, not an authority. It holds ciphertext and never a key, a group secret
// or a plaintext; identity anchors live on chain in `identities`. It is also one implementation of a
// swappable port: `convId` is derived by the clients and message ids are client-generated, so no
// server-assigned identifier and no server-authoritative ordering may become load-bearing — that
// constraint is what keeps a different transport able to serve the same conversations.

/**
 * A single-use MLS KeyPackage in a subject's pool.
 *
 * `id` is supplied by the caller as a content hash of `keyPackage`, which is what makes re-upload
 * idempotent. The store deliberately does no hashing itself, so it needs no crypto dependency and
 * the dedupe rule stays visible at the call site.
 */
export type DmKeyPackage = {
  readonly id: string;
  readonly subject: string;
  readonly keyPackage: Uint8Array;
  readonly createdAt: string;
};

export type DmMessage = {
  readonly id: string;
  readonly convId: string;
  /** Claimed sender. Authenticated by MLS, never by this column — do not use it for authorization. */
  readonly sender: string;
  readonly recipient: string;
  readonly ciphertext: Uint8Array;
  readonly createdAt: string;
  /** The permit this delivery was made under, if any — what the recipient mutes by. */
  readonly permitJti?: string;
};

/** A pending MLS Welcome: group-entry material for a member who is not in the group yet. */
export type DmWelcome = {
  readonly id: string;
  readonly convId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly welcome: Uint8Array;
  readonly ratchetTree: Uint8Array;
  readonly createdAt: string;
  /** The permit this invite was made under, if any — what the recipient mutes by. */
  readonly permitJti?: string;
};

/** One row of a subject's inbox: a conversation plus when it last saw traffic. */
export type DmConversationSummary = {
  readonly convId: string;
  readonly peer: string;
  readonly lastMessageAt: string;
};

// The interface is Promise-based because implementations differ in when they resolve: the
// JSON store settles synchronously, the D1 store crosses a boundary per call. Consumers
// must not assume same-tick visibility.
export type ContentStore = {
  listCircles(): Promise<Circle[]>;
  getCircle(id: string): Promise<Circle | undefined>;
  createCircle(input: {
    name: string;
    description: string;
    subject: string;
    persona: string;
    disclosed: boolean;
    /** Whether anyone may join without an invite; fixed at creation because the address seals it. */
    isOpen: boolean;
  }): Promise<Circle>;
  /** Returns the membership, or an error string when the persona label is taken / already joined. */
  join(input: {
    circleId: string;
    subject: string;
    persona: string;
    disclosed: boolean;
  }): Promise<Membership | 'already-joined' | 'persona-taken'>;
  /**
   * Drop a membership row. `'not-a-member'` when there was none — distinguished from success so the
   * route can answer 404 rather than reporting a no-op as a departure.
   *
   * ⚠️ **The content row is the shadow, never the authority.** A circle's real membership is a leaf
   * in its on-chain `members` tree, and the chain half is `leaveCircle`. Removing this row alone
   * un-lists someone who can still prove membership; the app proves first and calls this after.
   */
  leave(circleId: string, subject: string): Promise<'left' | 'not-a-member'>;
  getMembership(circleId: string, subject: string): Promise<Membership | undefined>;
  listProposals(circleId: string): Promise<Proposal[]>;
  getProposal(id: string): Promise<Proposal | undefined>;
  createProposal(input: { circleId: string; title: string; body: string; author: string }): Promise<Proposal>;
  /** One vote per subject per proposal — mirrors the action-nullifier rule. */
  castVote(input: { proposalId: string; subject: string; value: 'yes' | 'no' }): Promise<Proposal | 'already-voted'>;
  hasVoted(proposalId: string, subject: string): Promise<boolean>;
  /** Every post in the circle, oldest first. Channel filtering is the caller's, so a thread's parent is always present. */
  listPosts(circleId: string): Promise<Post[]>;
  getPost(id: string): Promise<Post | undefined>;
  createPost(input: {
    circleId: string;
    parentId?: string;
    channelId?: string;
    body: string;
    author: string;
  }): Promise<Post>;
  listChannels(circleId: string): Promise<Channel[]>;
  /**
   * Create a channel, or say why not.
   *
   * `'name-taken'` rather than an upsert: a channel is referred to by name, so silently returning
   * someone else's channel would hand the caller a stream they did not create.
   */
  createChannel(input: {
    circleId: string;
    name: string;
    description?: string;
    createdBy: string;
  }): Promise<Channel | 'name-taken'>;
  /**
   * Rename a channel and/or change its description. Founder-gated at the route, like creating one.
   *
   * ⚠️ **`description: null` clears it; omitting the field leaves it unchanged.** Those are different
   * intents and collapsing them would make "remove this description" unexpressible — the panel renders
   * an absent one as nothing at all, so clearing is a thing a founder can actually want.
   *
   * `'not-found'` covers a channel id that is not this circle's, so a caller cannot rename someone
   * else's channel by guessing an id.
   */
  updateChannel(input: {
    circleId: string;
    channelId: string;
    name?: string;
    description?: string | null;
  }): Promise<Channel | 'name-taken' | 'not-found'>;
  setCircleChain(circleId: string, chain: ChainRef): Promise<void>;
  /**
   * Record the circle's on-chain founder — its leaf, and the subject that proved the deploy.
   *
   * Written only from the creator-only settle route, which is what makes the pair meaningful.
   */
  setCircleFounder(circleId: string, founderLeaf: string, founderSubject: string): Promise<void>;
  /** Records which compile of `circle.compact` this circle's contract was deployed from. */
  setCircleCodeDigest(circleId: string, codeDigest: string): Promise<void>;
  /** Set the circle's rail character. Founder-gated at the route. */
  setCircleDisplayChar(circleId: string, displayChar: string): Promise<void>;

  // ── Self-service invites ──────────────────────────────────────────────────────────────────
  /** What this circle demands of a stake key, or `undefined` for no self-service path. */
  getCircleInvitePolicy(circleId: string): Promise<StoredInvitePolicy | undefined>;
  /** Set or replace the policy. Founder-gated at the route. */
  setCircleInvitePolicy(
    circleId: string,
    rules: readonly { readonly kind: string; readonly param: string | null }[],
    authorityCommitment: string | null,
  ): Promise<void>;
  /** Remove the policy, closing the self-service path. Issued invites stay valid on chain. */
  clearCircleInvitePolicy(circleId: string): Promise<void>;
  /**
   * Claim a slot for one wallet **before** minting, so the mint has somewhere to land.
   *
   * ⚠️ **Reserved first, on purpose.** Two concurrent claims from the same wallet would both read
   * "no existing invite", both mint, and the second's row would then lose the unique index — leaving
   * an invite on chain that nobody was ever handed. Taking the row first makes the loser lose before
   * anything is spent. Implementations must make this a single conditional write.
   *
   * `'already-claimed'` → this wallet holds one; read it with {@link ContentStore.getClaimedCircleInvite}.
   */
  reserveCircleInvite(
    circleId: string,
    invite: { readonly commitment: string; readonly secret: string },
    claimant: string,
  ): Promise<'reserved' | 'already-claimed'>;
  /** Mark one invite's commitment as landed on chain. */
  confirmCircleInvite(circleId: string, commitment: string): Promise<void>;
  /**
   * Drop a reservation whose mint never happened, so the wallet can try again.
   *
   * Only ever called on a row still `pending`: a confirmed commitment is on chain and deleting our
   * copy would leave a live invite nobody can account for.
   */
  releaseCircleInvite(circleId: string, commitment: string): Promise<void>;
  /**
   * The invite already issued to this claimant, if any.
   *
   * ⚠️ Checked before minting so a repeated request returns the *same* code rather than issuing
   * another: a user who loses the response, or taps twice, must not cost the circle a second mint.
   * Carries `chainStatus` because a `pending` row means "mint again" rather than "hand this over".
   */
  getClaimedCircleInvite(circleId: string, claimant: string): Promise<ClaimedInvite | undefined>;
  setMembershipChain(circleId: string, subject: string, chain: ChainRef): Promise<void>;
  setProposalChain(proposalId: string, chain: ChainRef): Promise<void>;
  setVoteChain(proposalId: string, subject: string, chain: ChainRef): Promise<void>;
  getVoteChain(proposalId: string, subject: string): Promise<ChainRef | undefined>;
  /** Failed chain-mirror tasks eligible for re-enqueueing, dependency-ordered. */
  listChainBacklog(): Promise<ChainBacklogItem[]>;
  /** Upsert by token — a token belongs to exactly one subject (last write wins). */
  registerDevice(subject: string, device: { fcmToken: string; platform: string }): Promise<void>;
  listDevices(subject: string): Promise<Device[]>;
  /**
   * Forget a push token. Keyed by the token rather than the subject because that is what the push
   * provider reports as dead, and a token is unique across subjects (it identifies an install).
   * Idempotent: removing an unknown token is not an error.
   */
  removeDevice(fcmToken: string): Promise<void>;
  /** Subjects of a circle's members — service-side only (notification fan-out). */
  listMemberSubjects(circleId: string): Promise<string[]>;
  /** Reverse persona → subject within a circle (personas are unique per circle). */
  findSubjectByPersona(circleId: string, persona: string): Promise<string | undefined>;

  // ── Direct messages ──
  /** Idempotent by `id`: re-uploading a package already in the pool is a no-op. Returns rows added. */
  publishDmKeyPackages(subject: string, packages: readonly {id: string; keyPackage: Uint8Array}[]): Promise<number>;
  /** How many unclaimed packages remain — the client refills when this runs low. */
  countDmKeyPackages(subject: string): Promise<number>;
  /**
   * Take one package, marking it spent. MLS init keys are single-use, so a claim must never hand
   * out the same package twice; `undefined` means the pool is empty and the peer cannot be added
   * until they refill. Do not substitute a stale package.
   */
  claimDmKeyPackage(subject: string, claimedBy: string): Promise<DmKeyPackage | undefined>;
  /**
   * How many packages `claimedBy` has taken from `subject`'s pool since `sinceIso`.
   *
   * ⚠️ **A bound on draining, not a consent gate.** Anyone may still claim; this only stops one
   * actor emptying a pool, which leaves the owner unreachable until their device refills
   * (`docs/ABUSE_MITIGATION.md` §5, D3). Identity is free, so a determined attacker spreads the
   * same drain across fresh subjects — the fix for *that* is the consent layer, not a bigger cap.
   */
  countRecentDmClaims(subject: string, claimedBy: string, sinceIso: string): Promise<number>;

  // ── DM consent (docs/ABUSE_MITIGATION.md §5) ──
  /** A subject's policy, or `undefined` when they have never set one (which means `open`). */
  readDmPolicy(subject: string): Promise<DmPolicy | undefined>;
  /** Set a subject's policy. Idempotent. */
  writeDmPolicy(subject: string, policy: DmPolicy, atIso: string): Promise<void>;
  /**
   * Silence a permit from `atIso` onward, until the permit would have expired anyway.
   *
   * ⚠️ Stores the opaque id and nothing else — no subject, no peer. `atIso` is a cutoff rather than
   * a flag so that re-issuing after a mute produces a token this row does not cover, which is how
   * unmute works without a second table.
   */
  revokeDmPermit(jti: string, atIso: string, expiresAtIso: string): Promise<void>;
  /** When `jti` was revoked, or `undefined` if it never was. */
  readDmPermitRevocation(jti: string): Promise<string | undefined>;
  /** Lift a revocation outright, for an unmute that does not wait for a fresh permit. */
  clearDmPermitRevocation(jti: string): Promise<void>;
  /** Refuse everything from `peer`, now and in future. Idempotent. */
  blockDmPeer(subject: string, peer: string, atIso: string): Promise<void>;
  /** Undo a block. Idempotent. */
  unblockDmPeer(subject: string, peer: string): Promise<void>;
  /** Whether `subject` has blocked `peer`. */
  isDmPeerBlocked(subject: string, peer: string): Promise<boolean>;
  /** Everyone `subject` has blocked, newest first. */
  listDmBlocks(subject: string): Promise<{ peer: string; createdAt: string }[]>;
  /**
   * Withdraw packages the owner can no longer use, returning how many were removed.
   *
   * ⚠️ **Unclaimed rows only.** A claimed row is the tombstone that makes `publishDmKeyPackages`
   * refuse to resurrect a spent init key — deleting it would let the same single-use package be
   * re-published and handed out twice. It is also pointless: a peer who already claimed one holds
   * the bytes, and nothing here can take them back.
   *
   * Scoped to `subject` so a caller can only retire its own. Idempotent: unknown ids remove nothing.
   */
  retireDmKeyPackages(subject: string, ids: readonly string[]): Promise<number>;
  /**
   * Withdraw **every** unclaimed package a subject has published.
   *
   * ⚠️ For a device that has lost its private halves wholesale — a storage reset, a reinstall, a
   * restore — where the id-scoped retire cannot help because the ids went with them. Left alone, the
   * pool stays full of packages nobody can open: `ensureKeyPackagePool` sees a healthy count and
   * publishes nothing, while every peer who claims one gets an invite that dies on arrival.
   *
   * Claimed rows are kept, for the same reason as the scoped retire: they are the tombstone that
   * stops a spent single-use init key being re-published.
   */
  retireAllDmKeyPackages(subject: string): Promise<number>;
  appendDmMessage(input: {
    id: string;
    convId: string;
    sender: string;
    recipient: string;
    ciphertext: Uint8Array;
    /** The permit this delivery was made under, so the recipient can learn its id and mute it. */
    permitJti?: string;
  }): Promise<DmMessage>;
  /**
   * Messages in a conversation **that `subject` is a party to**, oldest first; `since` is an
   * exclusive `createdAt` cursor.
   *
   * ⚠️ **Scoped to the caller, and that is load-bearing.** A conversation id is a hash of two
   * public `pnyx_id`s, so anyone who can name two identities can compute it — filtering on
   * `conv_id` alone let a stranger read any pair's traffic. MLS keeps the *content* safe; senders,
   * timing, count and size are not, and that is the social graph we are not supposed to publish.
   * A non-party gets an empty list rather than a refusal, so this is also not an oracle for
   * whether a conversation exists.
   */
  listDmMessages(convId: string, subject: string, since?: string): Promise<DmMessage[]>;
  /** Conversations involving a subject as either party, most recent first. */
  listDmConversations(subject: string): Promise<DmConversationSummary[]>;
  putDmWelcome(input: {
    id: string;
    convId: string;
    sender: string;
    recipient: string;
    welcome: Uint8Array;
    ratchetTree: Uint8Array;
    /** The permit this invite was made under; see {@link ContentStore.appendDmMessage}. */
    permitJti?: string;
  }): Promise<DmWelcome>;
  /**
   * Fetch and delete a recipient's pending Welcomes. Single-use by design: retaining group-entry
   * material after the join would leave it on the server for no reason.
   */
  /**
   * Pending Welcomes, **without consuming them**.
   *
   * ⚠️ Replaces a destructive `takeDmWelcomes`, which deleted on read and so made delivery
   * at-most-once on a payload that cannot be regenerated: a Welcome is single-use, so anything that
   * went wrong between the server's delete and the client durably saving group state lost the invite
   * for ever — a dropped response, an app killed mid-drain, a join that threw, a missing private
   * half. The recipient now confirms with {@link ackDmWelcomes}, and until then it is redelivered.
   */
  listDmWelcomes(recipient: string): Promise<DmWelcome[]>;
  /**
   * Drop Welcomes the recipient has durably joined. Scoped to the recipient, so nobody can retire
   * an invite addressed to somebody else. Idempotent: unknown ids remove nothing.
   */
  ackDmWelcomes(recipient: string, ids: readonly string[]): Promise<number>;
  /**
   * Drop delivered messages.
   *
   * Scoped to `recipient` because that is who can attest to delivery — a sender acking its own
   * outgoing message would delete it before the other side ever fetched it. One row serves both
   * parties, and the sender needs no copy: its plaintext was stored at send, and MLS gives a sender
   * no way to reopen its own message anyway.
   */
  ackDmMessages(recipient: string, ids: readonly string[]): Promise<number>;

  /**
   * Delete DM state nobody is coming back for, and bound every subject's key-package pool.
   *
   * ⚠️ **The only reaper that does not need the device.** Every other deletion in this port is the
   * recipient's or the owner's own act, so an install that is gone leaves its rows for ever — and a
   * reinstalled one cannot even name the packages it published. See `dm-retention.ts` for why the
   * pool half of this is a liveness fix rather than a storage one.
   *
   * Idempotent and safe to run concurrently with delivery: every rule is a delete or an update
   * keyed on a timestamp already in the past, so a row written during the sweep is outside it.
   */
  sweepDmRetention(policy: DmRetentionPolicy, nowMs: number): Promise<DmRetentionOutcome>;
};

type Persisted = {
  circles: Omit<Circle, 'memberCount'>[];
  memberships: { circleId: string; subject: string; membership: Membership }[];
  proposals: Proposal[];
  posts: Post[];
  /** Subjects that voted, per proposal — enforces vote-once; values live only in tallies. */
  voters: { proposalId: string; subjects: string[] }[];
  voteChains?: { key: string; chain: ChainRef }[];
  /**
   * Per-subject vote values, kept ONLY so a failed chain mirror tx can be replayed after a
   * restart (the chain client needs the ballot value again). Part of the documented
   * dev-mode trust gap — the server already holds the subject↔persona mapping; the API
   * still never exposes per-subject values.
   */
  voteValues?: { key: string; value: 'yes' | 'no' }[];
  /** Optional: a snapshot written before channels existed simply has none. */
  channels?: Channel[];
  devices?: { fcmToken: string; subject: string; platform: string; registeredAt: string }[];
};

export const createContentStore = (options?: { file?: string; random?: () => string }): ContentStore => {
  const file = options?.file;
  const random = options?.random ?? (() => crypto.randomUUID());
  const circles = new Map<string, Omit<Circle, 'memberCount'>>();
  const memberships = new Map<string, Map<string, Membership>>();
  const proposals = new Map<string, Proposal>();
  const posts = new Map<string, Post>();
  const channels = new Map<string, Channel>();
  const votedBy = new Map<string, Set<string>>();
  const invitePolicies = new Map<string, StoredInvitePolicy>();
  /** Mutable rows, so a confirmation can mark one in place the way the D1 UPDATE does. */
  const invitePool = new Map<
    string,
    {
      commitment: string;
      secret: string;
      chainStatus: 'pending' | 'confirmed';
      claimedBy: string | null;
      claimedAt?: string;
      createdAt: string;
    }[]
  >();
  const voteChains = new Map<string, ChainRef>();
  const voteValues = new Map<string, 'yes' | 'no'>();
  const devices = new Map<string, { subject: string; platform: string; registeredAt: string }>();
  // DM delivery state — in memory only, never in the JSON snapshot (see the DM block below).
  const dmKeyPackages = new Map<string, DmKeyPackage & { claimed: boolean; claimedBy?: string; claimedAt?: string }>();
  const dmPolicies = new Map<string, DmPolicy>();
  const dmRevocations = new Map<string, { revokedAt: string; expiresAt: string }>();
  const dmBlocks = new Map<string, { subject: string; peer: string; createdAt: string }>();
  const dmMessages = new Map<string, DmMessage>();
  const dmWelcomes = new Map<string, DmWelcome>();
  const voteKey = (proposalId: string, subject: string) => `${proposalId}:${subject}`;

  if (file && fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Persisted;
    for (const circle of data.circles) {
      // A file written before the gate existed holds circles that were all deployed with `isOpen`
      // hard-coded true, so open is what they are — not a default standing in for an unknown.
      circles.set(circle.id, { ...circle, isOpen: circle.isOpen ?? true });
    }
    for (const entry of data.memberships) {
      const byMember = memberships.get(entry.circleId) ?? new Map<string, Membership>();
      byMember.set(entry.subject, entry.membership);
      memberships.set(entry.circleId, byMember);
    }
    for (const proposal of data.proposals) {
      proposals.set(proposal.id, proposal);
    }
    for (const post of data.posts) {
      posts.set(post.id, post);
    }
    // Absent in a snapshot written before channels existed, which is not the same as an empty list —
    // but both restore to no channels, and the circle's default stream is unaffected either way.
    for (const channel of data.channels ?? []) {
      channels.set(channel.id, channel);
    }
    for (const entry of data.voters) {
      votedBy.set(entry.proposalId, new Set(entry.subjects));
    }
    for (const entry of data.voteChains ?? []) {
      voteChains.set(entry.key, entry.chain);
    }
    for (const entry of data.voteValues ?? []) {
      voteValues.set(entry.key, entry.value);
    }
    for (const entry of data.devices ?? []) {
      devices.set(entry.fcmToken, { subject: entry.subject, platform: entry.platform, registeredAt: entry.registeredAt });
    }
  }

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    if (!file) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const data: Persisted = {
        circles: [...circles.values()],
        memberships: [...memberships.entries()].flatMap(([circleId, byMember]) =>
          [...byMember.entries()].map(([subject, membership]) => ({ circleId, subject, membership })),
        ),
        proposals: [...proposals.values()],
        posts: [...posts.values()],
        channels: [...channels.values()],
        voters: [...votedBy.entries()].map(([proposalId, subjects]) => ({ proposalId, subjects: [...subjects] })),
        voteChains: [...voteChains.entries()].map(([key, chain]) => ({ key, chain })),
        voteValues: [...voteValues.entries()].map(([key, value]) => ({ key, value })),
        devices: [...devices.entries()].map(([fcmToken, d]) => ({ fcmToken, ...d })),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }, 100);
    // Read structurally: a pending flush must not hold the process open, but whether `setTimeout`
    // is Node's (has `unref`) or the DOM's (a number) depends on the tsconfig doing the checking.
    (flushTimer as { unref?: () => void }).unref?.();
  };

  const byNewest = <T extends { createdAt: string }>(items: T[]): T[] =>
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const withMemberCount = (circle: Omit<Circle, 'memberCount'>): Circle => ({
    ...circle,
    memberCount: memberships.get(circle.id)?.size ?? 0,
  });

  const personaTaken = (circleId: string, persona: string): boolean => {
    const byMember = memberships.get(circleId);
    if (!byMember) {
      return false;
    }
    const lowered = persona.toLowerCase();
    return [...byMember.values()].some((m) => m.persona.toLowerCase() === lowered);
  };

  const join = ({
    circleId,
    subject,
    persona,
    disclosed,
  }: {
    circleId: string;
    subject: string;
    persona: string;
    disclosed: boolean;
  }): Membership | 'already-joined' | 'persona-taken' => {
    const byMember = memberships.get(circleId) ?? new Map<string, Membership>();
    if (byMember.has(subject)) {
      return 'already-joined';
    }
    if (personaTaken(circleId, persona)) {
      return 'persona-taken';
    }
    const membership: Membership = { persona, disclosed, joinedAt: new Date().toISOString() };
    byMember.set(subject, membership);
    memberships.set(circleId, byMember);
    persist();
    return membership;
  };

  return {
    listCircles: async () => byNewest([...circles.values()].map(withMemberCount)),
    getCircle: async (id) => {
      const circle = circles.get(id);
      return circle ? withMemberCount(circle) : undefined;
    },
    createCircle: async ({ name, description, subject, persona, disclosed, isOpen }) => {
      const circle = {
        id: random(),
        name,
        description,
        author: persona,
        createdAt: new Date().toISOString(),
        isOpen,
      };
      circles.set(circle.id, circle);
      join({ circleId: circle.id, subject, persona, disclosed });
      persist();
      return withMemberCount(circle);
    },
    join: async (input) => join(input),
    leave: async (circleId, subject) => {
      const byMember = memberships.get(circleId);
      if (!byMember?.delete(subject)) {
        return 'not-a-member';
      }
      persist();
      return 'left';
    },
    getMembership: async (circleId, subject) => memberships.get(circleId)?.get(subject),
    listProposals: async (circleId) => byNewest([...proposals.values()].filter((p) => p.circleId === circleId)),
    getProposal: async (id) => proposals.get(id),
    createProposal: async ({ circleId, title, body, author }) => {
      const proposal: Proposal = {
        id: random(),
        circleId,
        title,
        body,
        author,
        createdAt: new Date().toISOString(),
        tally: { yes: 0, no: 0 },
      };
      proposals.set(proposal.id, proposal);
      persist();
      return proposal;
    },
    castVote: async ({ proposalId, subject, value }) => {
      const proposal = proposals.get(proposalId);
      if (!proposal) {
        throw new Error(`no such proposal: ${proposalId}`);
      }
      const set = votedBy.get(proposalId) ?? new Set<string>();
      if (set.has(subject)) {
        return 'already-voted';
      }
      set.add(subject);
      votedBy.set(proposalId, set);
      voteValues.set(voteKey(proposalId, subject), value);
      const updated: Proposal = {
        ...proposal,
        tally: { yes: proposal.tally.yes + (value === 'yes' ? 1 : 0), no: proposal.tally.no + (value === 'no' ? 1 : 0) },
      };
      proposals.set(proposalId, updated);
      persist();
      return updated;
    },
    hasVoted: async (proposalId, subject) => votedBy.get(proposalId)?.has(subject) ?? false,
    listPosts: async (circleId) =>
      [...posts.values()].filter((p) => p.circleId === circleId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    getPost: async (id) => posts.get(id),
    createPost: async ({ circleId, parentId, channelId, body, author }) => {
      const post: Post = {
        id: random(),
        circleId,
        ...(parentId === undefined ? {} : { parentId }),
        ...(channelId === undefined ? {} : { channelId }),
        body,
        author,
        createdAt: new Date().toISOString(),
      };
      posts.set(post.id, post);
      persist();
      return post;
    },
    listChannels: async (circleId) =>
      [...channels.values()]
        .filter((c) => c.circleId === circleId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    createChannel: async ({ circleId, name, description, createdBy }) => {
      const taken = [...channels.values()].some((c) => c.circleId === circleId && c.name === name);
      if (taken) {
        return 'name-taken';
      }
      const channel: Channel = {
        id: random(),
        circleId,
        name,
        ...(description === undefined ? {} : { description }),
        createdBy,
        createdAt: new Date().toISOString(),
      };
      channels.set(channel.id, channel);
      persist();
      return channel;
    },
    updateChannel: async ({ circleId, channelId, name, description }) => {
      const existing = channels.get(channelId);
      // Scoped to the circle, not just to the id: a channel from another circle must read as absent
      // rather than be renamed by whoever founded this one.
      if (!existing || existing.circleId !== circleId) {
        return 'not-found';
      }
      if (name !== undefined && name !== existing.name) {
        const taken = [...channels.values()].some((c) => c.circleId === circleId && c.name === name);
        if (taken) {
          return 'name-taken';
        }
      }
      // `null` clears, `undefined` leaves alone. Built by picking the resulting description first so
      // "absent" is the same shape `createChannel` produces rather than a key set to something falsy.
      const nextDescription = description === undefined ? existing.description : (description ?? undefined);
      const next: Channel = {
        ...existing,
        ...(name === undefined ? {} : { name }),
        ...(nextDescription === undefined ? {} : { description: nextDescription }),
      };
      if (nextDescription === undefined) {
        delete (next as { description?: string }).description;
      }
      channels.set(channelId, next);
      persist();
      return next;
    },
    setCircleChain: async (circleId, chain) => {
      const circle = circles.get(circleId);
      if (circle) {
        circles.set(circleId, { ...circle, chain });
        persist();
      }
    },
    setCircleCodeDigest: async (circleId, codeDigest) => {
      const circle = circles.get(circleId);
      if (circle) {
        circles.set(circleId, { ...circle, codeDigest });
        persist();
      }
    },
    setCircleDisplayChar: async (circleId, displayChar) => {
      const circle = circles.get(circleId);
      if (circle) {
        circles.set(circleId, { ...circle, displayChar });
        persist();
      }
    },
    getCircleInvitePolicy: async (circleId) => invitePolicies.get(circleId),
    setCircleInvitePolicy: async (circleId, rules, authorityCommitment) => {
      // Replaced wholesale, matching D1: the rule set is edited as a set, and a merge would leave a
      // rule the founder deleted still gating the circle. Sorted by kind for the same reason D1's
      // read is — two backends that return one circle's rules in different orders make any test that
      // pins the order true on one of them and a coincidence on the other.
      invitePolicies.set(circleId, {
        rules: [...rules]
          .map((r) => ({ kind: r.kind, param: r.param }))
          .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
        authorityCommitment,
        updatedAt: new Date().toISOString(),
      });
    },
    clearCircleInvitePolicy: async (circleId) => {
      invitePolicies.delete(circleId);
    },
    reserveCircleInvite: async (circleId, invite, claimant) => {
      const pool = invitePool.get(circleId) ?? [];
      // Single-process, so D1's concurrency argument does not apply here — but the *decision* must
      // match it, or the two backends disagree about which of two racing requests won.
      if (pool.some((p) => p.claimedBy === claimant)) return 'already-claimed';
      pool.push({
        ...invite,
        chainStatus: 'pending',
        claimedBy: claimant,
        claimedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      invitePool.set(circleId, pool);
      return 'reserved';
    },
    confirmCircleInvite: async (circleId, commitment) => {
      const found = invitePool.get(circleId)?.find((p) => p.commitment === commitment);
      if (found) found.chainStatus = 'confirmed';
    },
    releaseCircleInvite: async (circleId, commitment) => {
      const pool = invitePool.get(circleId);
      if (pool === undefined) return;
      // Only a pending row, matching D1: a confirmed commitment is on chain, and dropping our copy
      // would leave a live invite nobody can account for.
      invitePool.set(
        circleId,
        pool.filter((p) => !(p.commitment === commitment && p.chainStatus === 'pending')),
      );
    },
    getClaimedCircleInvite: async (circleId, claimant) => {
      const found = (invitePool.get(circleId) ?? []).find((p) => p.claimedBy === claimant);
      return found === undefined
        ? undefined
        : { commitment: found.commitment, secret: found.secret, chainStatus: found.chainStatus };
    },
    setCircleFounder: async (circleId, founderLeaf, founderSubject) => {
      const circle = circles.get(circleId);
      if (circle) {
        circles.set(circleId, { ...circle, founderLeaf, founderSubject });
        persist();
      }
    },
    setMembershipChain: async (circleId, subject, chain) => {
      const byMember = memberships.get(circleId);
      const membership = byMember?.get(subject);
      if (byMember && membership) {
        byMember.set(subject, { ...membership, chain });
        persist();
      }
    },
    setProposalChain: async (proposalId, chain) => {
      const proposal = proposals.get(proposalId);
      if (proposal) {
        proposals.set(proposalId, { ...proposal, chain });
        persist();
      }
    },
    setVoteChain: async (proposalId, subject, chain) => {
      voteChains.set(voteKey(proposalId, subject), chain);
      persist();
    },
    getVoteChain: async (proposalId, subject) => voteChains.get(voteKey(proposalId, subject)),
    listChainBacklog: async () => {
      const backlog: ChainBacklogItem[] = [];
      for (const circle of circles.values()) {
        if (circle.chain?.status === 'failed') {
          backlog.push({ kind: 'circle', circleId: circle.id });
        }
      }
      for (const [circleId, byMember] of memberships.entries()) {
        for (const [subject, membership] of byMember.entries()) {
          if (membership.chain?.status === 'failed') {
            backlog.push({ kind: 'membership', circleId, subject });
          }
        }
      }
      for (const proposal of proposals.values()) {
        if (proposal.chain?.status !== 'failed') {
          continue;
        }
        // The proposal stores only the author's persona label; recover the subject through
        // the circle's membership map (persona labels are unique per circle).
        const byMember = memberships.get(proposal.circleId);
        const authorSubject = byMember
          ? [...byMember.entries()].find(([, m]) => m.persona === proposal.author)?.[0]
          : undefined;
        if (authorSubject) {
          backlog.push({ kind: 'proposal', circleId: proposal.circleId, proposalId: proposal.id, authorSubject });
        }
      }
      for (const [key, chain] of voteChains.entries()) {
        if (chain.status !== 'failed') {
          continue;
        }
        // Key shape `${proposalId}:${subject}` — proposal ids never contain ':', subjects may.
        const separator = key.indexOf(':');
        const proposalId = key.slice(0, separator);
        const subject = key.slice(separator + 1);
        const circleId = proposals.get(proposalId)?.circleId;
        const value = voteValues.get(key);
        if (circleId && value) {
          backlog.push({ kind: 'vote', circleId, proposalId, subject, value });
        }
      }
      return backlog;
    },
    registerDevice: async (subject, { fcmToken, platform }) => {
      devices.set(fcmToken, { subject, platform, registeredAt: new Date().toISOString() });
      persist();
    },
    listDevices: async (subject) =>
      [...devices.entries()]
        .filter(([, d]) => d.subject === subject)
        .map(([fcmToken, d]) => ({ fcmToken, platform: d.platform, registeredAt: d.registeredAt })),
    removeDevice: async (fcmToken) => {
      if (devices.delete(fcmToken)) persist();
    },
    listMemberSubjects: async (circleId) => [...(memberships.get(circleId)?.keys() ?? [])],
    findSubjectByPersona: async (circleId, persona) => {
      const byMember = memberships.get(circleId);
      if (!byMember) {
        return undefined;
      }
      return [...byMember.entries()].find(([, m]) => m.persona === persona)?.[0];
    },

    // ── Direct messages ──
    // Not written to the JSON snapshot: ciphertext and single-use group material are transient
    // delivery state, and a dev restart losing undelivered frames is the correct behaviour (the
    // sender re-sends). Persisting them would put group-entry material in a plaintext file.
    publishDmKeyPackages: async (subject, packages) => {
      let added = 0;
      for (const {id, keyPackage} of packages) {
        if (dmKeyPackages.has(id)) continue;
        dmKeyPackages.set(id, {id, subject, keyPackage, createdAt: new Date().toISOString(), claimed: false});
        added += 1;
      }
      return added;
    },
    countDmKeyPackages: async (subject) =>
      [...dmKeyPackages.values()].filter((p) => p.subject === subject && !p.claimed).length,
    retireAllDmKeyPackages: async (subject) => {
      let retired = 0;
      for (const held of [...dmKeyPackages.values()]) {
        if (held.subject !== subject || held.claimed) continue;
        dmKeyPackages.delete(held.id);
        retired += 1;
      }
      return retired;
    },
    retireDmKeyPackages: async (subject, ids) => {
      let retired = 0;
      for (const id of ids) {
        const held = dmKeyPackages.get(id);
        if (held === undefined || held.subject !== subject || held.claimed) continue;
        dmKeyPackages.delete(id);
        retired += 1;
      }
      return retired;
    },
    claimDmKeyPackage: async (subject, claimedBy) => {
      // Newest first, matching D1 — see the note there for why FIFO hands out the orphaned batch.
      const available = [...dmKeyPackages.values()]
        .filter((p) => p.subject === subject && !p.claimed)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const next = available[0];
      if (!next) return undefined;
      dmKeyPackages.set(next.id, {...next, claimed: true, claimedBy, claimedAt: new Date().toISOString()});
      return {id: next.id, subject: next.subject, keyPackage: next.keyPackage, createdAt: next.createdAt};
    },
    readDmPolicy: async (subject) => dmPolicies.get(subject),
    writeDmPolicy: async (subject, policy) => {
      dmPolicies.set(subject, policy);
    },
    revokeDmPermit: async (jti, atIso, expiresAtIso) => {
      dmRevocations.set(jti, { revokedAt: atIso, expiresAt: expiresAtIso });
    },
    readDmPermitRevocation: async (jti) => dmRevocations.get(jti)?.revokedAt,
    clearDmPermitRevocation: async (jti) => {
      dmRevocations.delete(jti);
    },
    blockDmPeer: async (subject, peer, atIso) => {
      dmBlocks.set(`${subject}\u0000${peer}`, { subject, peer, createdAt: atIso });
    },
    unblockDmPeer: async (subject, peer) => {
      dmBlocks.delete(`${subject}\u0000${peer}`);
    },
    isDmPeerBlocked: async (subject, peer) => dmBlocks.has(`${subject}\u0000${peer}`),
    listDmBlocks: async (subject) =>
      [...dmBlocks.values()]
        .filter((b) => b.subject === subject)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ peer, createdAt }) => ({ peer, createdAt })),
    countRecentDmClaims: async (subject, claimedBy, sinceIso) =>
      [...dmKeyPackages.values()].filter(
        (p) => p.subject === subject && p.claimedBy === claimedBy && (p.claimedAt ?? '') > sinceIso,
      ).length,
    appendDmMessage: async ({id, convId, sender, recipient, ciphertext, permitJti}) => {
      const message: DmMessage = {
        id,
        convId,
        sender,
        recipient,
        ciphertext,
        createdAt: new Date().toISOString(),
        ...(permitJti === undefined ? {} : {permitJti}),
      };
      dmMessages.set(id, message);
      return message;
    },
    listDmMessages: async (convId, subject, since) =>
      [...dmMessages.values()]
        .filter(
          (m) =>
            m.convId === convId &&
            (m.sender === subject || m.recipient === subject) &&
            (since === undefined || m.createdAt > since),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    listDmConversations: async (subject) => {
      const latest = new Map<string, DmConversationSummary>();
      for (const m of [...dmMessages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (m.sender !== subject && m.recipient !== subject) continue;
        const peer = m.sender === subject ? m.recipient : m.sender;
        latest.set(m.convId, {convId: m.convId, peer, lastMessageAt: m.createdAt});
      }
      return [...latest.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    },
    putDmWelcome: async ({id, convId, sender, recipient, welcome, ratchetTree, permitJti}) => {
      const record: DmWelcome = {
        id,
        convId,
        sender,
        recipient,
        welcome,
        ratchetTree,
        createdAt: new Date().toISOString(),
        ...(permitJti === undefined ? {} : {permitJti}),
      };
      dmWelcomes.set(id, record);
      return record;
    },
    listDmWelcomes: async (recipient) =>
      [...dmWelcomes.values()]
        .filter((w) => w.recipient === recipient)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ackDmWelcomes: async (recipient, ids) => {
      let removed = 0;
      for (const id of ids) {
        const held = dmWelcomes.get(id);
        if (held === undefined || held.recipient !== recipient) continue;
        dmWelcomes.delete(id);
        removed += 1;
      }
      return removed;
    },
    ackDmMessages: async (recipient, ids) => {
      let removed = 0;
      for (const id of ids) {
        const held = dmMessages.get(id);
        if (held === undefined || held.recipient !== recipient) continue;
        dmMessages.delete(id);
        removed += 1;
      }
      return removed;
    },
    sweepDmRetention: async (policy, nowMs) => {
      const cutoffs = dmRetentionCutoffs(policy, nowMs);
      let welcomesDeleted = 0;
      for (const welcome of [...dmWelcomes.values()]) {
        if (welcome.createdAt >= cutoffs.welcomesBefore) continue;
        dmWelcomes.delete(welcome.id);
        welcomesDeleted += 1;
      }
      let messagesDeleted = 0;
      for (const message of [...dmMessages.values()]) {
        if (message.createdAt >= cutoffs.messagesBefore) continue;
        dmMessages.delete(message.id);
        messagesDeleted += 1;
      }
      let unclaimedExpired = 0;
      for (const held of [...dmKeyPackages.values()]) {
        if (held.claimed || held.createdAt >= cutoffs.unclaimedBefore) continue;
        dmKeyPackages.delete(held.id);
        unclaimedExpired += 1;
      }
      // Per subject, and oldest first: the surplus to drop is always the older batch, which after a
      // reinstall is exactly the one whose private halves are gone.
      const bySubject = new Map<string, (DmKeyPackage & { claimed: boolean })[]>();
      for (const held of dmKeyPackages.values()) {
        if (held.claimed) continue;
        const pool = bySubject.get(held.subject) ?? [];
        pool.push(held);
        bySubject.set(held.subject, pool);
      }
      let unclaimedOverCap = 0;
      for (const pool of bySubject.values()) {
        if (pool.length <= policy.unclaimedPerSubject) continue;
        pool.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const held of pool.slice(0, pool.length - policy.unclaimedPerSubject)) {
          dmKeyPackages.delete(held.id);
          unclaimedOverCap += 1;
        }
      }
      let tombstonesBlanked = 0;
      for (const held of [...dmKeyPackages.values()]) {
        // `claimedAt` is not on `DmKeyPackage` — the JSON store keeps claiming in a flag, so the
        // claim instant it would compare against does not exist here. `createdAt` is the closest
        // thing it holds, and it is only ever *older*, so this store can blank a tombstone slightly
        // earlier than D1 would. Nothing reads those bytes either way (see the port's note).
        if (!held.claimed || held.keyPackage.length === 0 || held.createdAt >= cutoffs.tombstonesClaimedBefore) {
          continue;
        }
        dmKeyPackages.set(held.id, { ...held, keyPackage: new Uint8Array() });
        tombstonesBlanked += 1;
      }
      return { welcomesDeleted, messagesDeleted, unclaimedExpired, unclaimedOverCap, tombstonesBlanked };
    },
  };
};
