// Chain mirror — routes forum actions onto the deployed contract asynchronously.
// Content-plane writes stay optimistic and instant; each mirrored action carries a
// ChainRef that moves pending → confirmed/failed as its transaction lands (blocks are
// ~6 s on the dev chain, a vote is two transactions). Mirror ops run on a single ordered
// task chain so dependencies (circle before join before proposal before vote) always
// resolve, matching the chain client's own FIFO transaction queue.
import type { ChainClient } from '@pnyx/chain-client/client';
import { createSponsorQueue, storeSettlementSink } from './sponsor.js';
import type { ChainRef, ContentStore } from './store.js';

/**
 * The content-plane ChainRef a device-proven transaction settles (POST /chain/submit). The device
 * proved + signed the tx on-device; the service balances + submits it (chain client `submitProven`)
 * and flips this ref pending → confirmed/failed.
 *
 * `chainId` is device-computed and means a different thing per kind — a circle's **contract
 * address**, a proposal's sequential id (`proposalCount + 1`, baked into the proof). Absent for the
 * membership/vote kinds, which have no on-chain id. See {@link ChainRef.chainId}.
 */
export type ProvenSettlement =
  | { readonly kind: 'circle'; readonly circleId: string; readonly chainId?: string }
  | { readonly kind: 'membership'; readonly circleId: string; readonly subject: string }
  | { readonly kind: 'proposal'; readonly proposalId: string; readonly chainId?: string }
  | { readonly kind: 'vote'; readonly proposalId: string; readonly subject: string }
  /**
   * A circle invite whose commitment a moderator just published with `setInvite`.
   *
   * Keyed by the **commitment** rather than an id: the content plane has no row for an invite
   * until this settles, and the commitment is the only handle both sides already share. It is a
   * public ledger key, so naming it here discloses nothing the chain does not — unlike the
   * secret, which never reaches this path at all.
   */
  | { readonly kind: 'invite'; readonly circleId: string; readonly commitment: string }
  /**
   * The caller's own value transfer — a Midnight send, sponsored for its DUST fee.
   *
   * Unlike every other kind there is **no content-plane row to settle**: the transaction moves the
   * caller's own funds and the chain is the only record of it. `subject` is here because it is the
   * one thing that bounds the route (a transfer's bytes say nothing about whose they are, unlike a
   * contract call the policy can fingerprint), so it is what the rate limit keys on and what the
   * journal names.
   */
  | { readonly kind: 'transfer'; readonly subject: string }
  /**
   * A founder delegating (or withdrawing) their circle's invite authority with `setInviteAuthority`.
   *
   * Like a transfer, it settles **no content-plane row**: the delegation lives in the circle's
   * `inviteAuthority` ledger cell and the chain is the only record of it. It is a distinct kind
   * rather than reusing `invite` because that one confirms a *commitment in the invites set*, and
   * an authority commitment is not one — filing it there would mark an invite that does not exist.
   *
   * `circleId` is carried for the journal and for the founder check at the route, not for a write.
   */
  | { readonly kind: 'invite-authority'; readonly circleId: string };

/**
 * Everything a submission carries besides the bytes.
 *
 * ⚠️ **Named rather than positional, and that is not cosmetic.** These were three trailing optionals,
 * and `keepAlive` is the one whose omission is invisible: a Worker cancels any promise still pending
 * when the response is returned, so forgetting it means the route answers 202, nothing ever reaches the
 * sponsor host, and neither side logs anything because nothing failed. A `transfer` loses it every
 * single time, because it has no content-plane row to write first and so nothing keeps the isolate alive
 * by accident. A field that has to be named is a field that gets noticed.
 */
export type SubmitContext = {
  /**
   * Joins the two halves of one action in the logs: the Worker records `cf-ray`, the sponsor host
   * records the same value. Never a key, never persisted.
   */
  readonly requestId?: string;
  /**
   * Hands the forwarding promise to the runtime that owns the request's lifetime. **Required on
   * Cloudflare** — see above. Absent on a Node server, where a promise lives until it settles.
   */
  readonly keepAlive?: (promise: Promise<unknown>) => void;
  /**
   * Which Midnight network the transaction is for.
   *
   * ⚠️ **A routing hint, not a claim to be believed.** The sponsor host holds one wallet per network
   * and needs to know which one to hand the bytes to; the wallet process then checks the bytes really
   * are its network's before it spends anything. Absent means "the host's default", which is what a
   * caller written before there was more than one network meant.
   */
  readonly network?: string;
};

export type ChainMirror = {
  readonly enabled: boolean;
  /**
   * Whether {@link ChainMirror.identityRow} works, **independently of the write mirror**.
   *
   * Login only needs to *read* a row; registration, forum mirroring and `/chain/*` need a funded,
   * synced, stateful host. Conflating the two under `enabled` meant a deployment that could read
   * (a Worker with an indexer query) still refused every login. Read-only deployments set this
   * `true` with `enabled` false.
   */
  readonly rowReads: boolean;
  /**
   * `identity.compact`'s **code digest** — what this deployment recognises an identity contract by,
   * served through `/auth/config` and reported by `/status`.
   *
   * ⚠️ Was `identityContractAddress`, on the premise that there was one global deployment. There is one
   * contract per identity now, at an address derived from `C`, so an address could name only one
   * person's — while the digest names the template every one of them is built from.
   */
  readonly identityCodeDigest?: string;
  /**
   * `circle.compact`'s code digest — the compile this deployment's clients prove against.
   *
   * A circle whose contract holds a different one still *reads*, because the ledger only ever gained
   * appended fields, but every proof against it is invalid and the sponsor refuses its calls. Serving
   * this is what lets a client say so rather than offering a door that does not open.
   */
  readonly circleCodeDigest?: string;
  /**
   * The code digest of whatever contract is deployed at `address`, or `undefined` when nothing is.
   *
   * Rejects when it could not look, so "no contract there" stays distinguishable from "the indexer is
   * down" — the second must not be recorded as a template verdict.
   */
  contractCodeDigestAt(address: string): Promise<string | undefined>;
  /**
   * Phase-B device-proving rail: balance + submit a transaction the CLIENT already proved, then
   * settle the referenced ChainRef. Enqueued on the same ordered task chain as the interim rail,
   * so the two coexist during the cutover.
   */
  /**
   * ⚠️ **Returns whether the sponsor *accepted* the bytes — not whether they landed.**
   *
   * The promise is deliberately not a rejection: every implementation records a failed ChainRef of its
   * own before answering, so a caller that ignores this is no worse off than before. What it buys is a
   * caller that *can* wait — `/chain/submit` awaits it for a `transfer`, which is the one settlement
   * with no content-plane row to carry the failure instead.
   *
   * ⚠️ **A `transfer` is also the one that must not be fire-and-forget any more.** Without this the
   * route answered 202, the sponsor refused the bytes, and the app recorded a pending send that nothing
   * would ever settle — a "Pending" row for a transaction that was refused before it left the building,
   * sitting on screen for the two hours until its own TTL abandoned it.
   */
  submitProven(
    settlement: ProvenSettlement,
    txBytes: Uint8Array,
    context?: SubmitContext,
  ): Promise<{readonly accepted: true; readonly txId?: string} | {readonly accepted: false; readonly error: string}>;
  /** The current on-chain contract state, serialized — for the device's native preimage builders. */
  contractState(): Promise<Uint8Array>;
  /**
   * One identity row by commitment, or `undefined` when unpublished
   * (`docs/PNYX_IDENTITY_PLAN.md`). No filtering: the circuit authenticated the write.
   *
   * `contract` is where to look — one contract per identity, so there is no single address to
   * configure. It is **supplied by the caller and therefore checked**: an implementation must satisfy
   * itself that the contract is built from our identity template and sealed to this `C` before
   * believing the `authPub` it finds.
   */
  identityRow(
    identity: Uint8Array,
    contract?: string,
  ): Promise<{anchor: Uint8Array; authPub: Uint8Array; name: Uint8Array} | undefined>;
  /**
   * Relay a client-proven `publishIdentityRow` transaction. The service cannot author one — the
   * circuit needs the identity secret — so this only balances and submits, which is what makes an
   * unauthenticated `/register` safe: the chain, not this endpoint, decides what is valid.
   */
  submitIdentityRow(txBytes: Uint8Array, context?: SubmitContext): Promise<void>;
  /** Resolves when every task enqueued so far has settled (tests, graceful shutdown). */
  whenIdle(): Promise<void>;
};

export const disabledChainMirror: ChainMirror = {
  enabled: false,
  rowReads: false,
  submitProven: () => Promise.resolve({ accepted: false as const, error: 'chain mirroring is disabled' }),
  contractState: () => Promise.reject(new Error('chain mirroring is disabled')),
  identityRow: () => Promise.reject(new Error('chain mirroring is disabled')),
  contractCodeDigestAt: () => Promise.reject(new Error('chain mirroring is disabled')),
  submitIdentityRow: () => Promise.reject(new Error('chain mirroring is disabled')),
  whenIdle: () => Promise.resolve(),
};

export const createChainMirror = (
  client: ChainClient,
  store: ContentStore,
  identityContractAddress: string | undefined,
  log: (message: string) => void,
  identityCodeDigest?: string,
): ChainMirror => {
  const sponsor = createSponsorQueue(client, storeSettlementSink(store), log);

  return {
    enabled: true,
    ...(identityCodeDigest === undefined ? {} : { identityCodeDigest }),
    // Delegated to the shared sponsor queue: this is the half that moves to the VPS, and the local
    // composition has to exercise the same code the deployed one runs (`sponsor.ts`).
    //
    // ⚠️ **Acceptance is the queue's real answer, not a constant.** This used to enqueue and return
    // `accepted: true` unconditionally, so a transfer that the node refused reached the device as a
    // 202 and sat there as "Pending" until its lock expired. The queue now resolves with where the
    // transaction landed, so a refusal can be reported as one.
    submitProven: async (settlement, txBytes, context) => {
      try {
        const tx = await sponsor.submitProven(settlement, txBytes, context?.requestId);
        return { accepted: true as const, txId: tx.txId };
      } catch (error) {
        return { accepted: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
    // A row read needs the identity contract, not the forum one — a mirror without it can write but
    // cannot answer a login, and saying so is what keeps `/auth/identity` from failing deeper down.
    rowReads: identityContractAddress !== undefined,
    contractState: () => client.readContractState(),
    identityRow: (identity) => client.readIdentityRow(identity),
    contractCodeDigestAt: () => Promise.reject(new Error('this deployment reads no contract digests')),
    // The local composition holds one wallet, so `context.network` has nothing to route to and is
    // ignored here rather than silently reinterpreted. The forwarding mirror is where it means something.
    submitIdentityRow: async (txBytes, context) => {
      await sponsor.submitIdentityRow(txBytes, context?.requestId);
    },
    whenIdle: () => sponsor.whenIdle(),
  };
};

// `replayChainBacklog` lived here: on boot it re-enqueued mirror tasks stuck in `failed` so a crash
// mid-backoff did not silently drop a user's action. It went with the server-proving rail, because
// every task it could replay was one this service proved on the user's behalf — and it cannot author
// those any more. A device-proven submission the sponsor accepted is replayed by the sponsor host's
// own backlog file (`sponsor-server.ts`), which is where the promise to submit is actually made.
//
// What is NOT covered, and is worth saying out loud: a transaction that failed *before* the sponsor
// accepted it now stays `failed` until the user retries from the device. The device holds the
// witnesses, so only the device can rebuild it — there was never a server-side replay for this rail,
// and the deleted one could not have provided it.
