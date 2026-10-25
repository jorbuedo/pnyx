// The origin's view of the sponsor host: forward proven transaction bytes inward, and accept the
// settlement reports that come back.
//
// The app talks to one origin (`pnyx.pxkq.uk`) and never learns the sponsor exists. Cloudflare cannot
// hold a wallet — no long-lived process, no continuous chain sync — so `/register` and `/chain/submit`
// hand their bytes to the host that can, over a Cloudflare Tunnel that the sponsor dials outward.
//
// Cloudflare keeps ownership of the ChainRef rows: the sponsor reports outcomes and the Worker writes
// D1. Two copies of "is this circle on chain yet" would mean two answers for one badge.

import type { ChainMirror, ProvenSettlement, SubmitContext } from './chain.js';
import { sponsorFailureReason } from './sponsor-failure.js';
import type { ChainRef, ContentStore } from './store.js';

export type SponsorLink = {
  /** Base URL the tunnel resolves to, e.g. `https://sponsor.internal`. */
  readonly url: string;
  /** Shared secret; the sponsor refuses anything without it. */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * A `ChainMirror` that forwards instead of holding a wallet.
 *
 * `enabled` is true — unlike the read-only mirror this replaces — because from the app's side the
 * chain plane *is* available: it can register and submit. What this deployment cannot do is serve
 * `/chain/state` or `/chain/artifacts`, and neither is needed any more (state comes from an indexer,
 * artifacts from R2).
 *
 * The server-proving methods stay no-ops. They belong to the interim rail the device rail replaced,
 * and forwarding them would mean proving on the sponsor host — the thing that would put a proof server
 * back on the box.
 */
export const forwardingChainMirror = (options: {
  readonly link: SponsorLink;
  readonly rowReads: boolean;
  /** The identity template this deployment recognises — reported by `/status` and `/auth/config`. */
  readonly identityCodeDigest?: string;
  /** The circle template its clients prove against — what a circle's own digest is compared to. */
  readonly circleCodeDigest?: string;
  readonly identityRow: ChainMirror['identityRow'];
  /** Reads a deployed contract's digest; absent in a deployment with no indexer. */
  readonly contractCodeDigestAt?: ChainMirror['contractCodeDigestAt'];
  readonly store: Pick<
    ContentStore,
    'getCircle' | 'setCircleChain' | 'setMembershipChain' | 'setProposalChain' | 'setVoteChain' | 'confirmCircleInvite'
  >;
  readonly log: (message: string) => void;
}): ChainMirror => {
  const doFetch = options.link.fetchImpl ?? fetch;
  const base = options.link.url.replace(/\/+$/, '');

  // `x-request-id` rather than forwarding `cf-ray` under its own name: `cf-*` headers on a subrequest
  // are Cloudflare's to set, and a value of ours travelling under their name is asking to be rewritten.
  //
  // ⚠️ **The network travels in the header *and* the body.** The header is what the sponsor host's
  // router reads without parsing a multi-megabyte base64 payload; the body copy is what makes the call
  // reproducible with any HTTP client, and what a direct-to-wallet call (no router) still carries.
  const post = async (path: string, body: object, context?: SubmitContext): Promise<Response> =>
    doFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.link.token}`,
        ...(context?.requestId === undefined ? {} : { 'x-request-id': context.requestId }),
        ...(context?.network === undefined ? {} : { 'x-midnight-network': context.network }),
      },
      body: JSON.stringify(context?.network === undefined ? body : { ...body, network: context.network }),
    });

  return {
    enabled: true,
    rowReads: options.rowReads,
    ...(options.identityCodeDigest === undefined ? {} : { identityCodeDigest: options.identityCodeDigest }),
    ...(options.circleCodeDigest === undefined ? {} : { circleCodeDigest: options.circleCodeDigest }),
    // Delegated to the caller's reader: this module forwards to the sponsor host and holds no
    // indexer of its own. A deployment without one says so rather than answering "current".
    contractCodeDigestAt: (address) =>
      options.contractCodeDigestAt === undefined
        ? Promise.reject(new Error('this deployment reads no contract digests'))
        : options.contractCodeDigestAt(address),
    // Interim server-proving rail — deleted, not forwarded.
    submitProven: (settlement, txBytes, context) => {
      // Pending is written here rather than on the sponsor's report, so the badge appears while the
      // bytes are still in flight — and so a tunnel that is down leaves a visible `pending` rather
      // than a circle with no chain state at all.
      // Handed to the runtime rather than merely started: see ChainMirror.submitProven. `void` alone
      // is what lost every sponsored transfer — the Worker returned 202 and cancelled this before the
      // fetch to the sponsor was ever made.
      const forwarding: Promise<{ accepted: true; txId?: string } | { accepted: false; error: string }> = applyPending(
        options.store,
        settlement,
      )
        .then(() => post('/internal/submit', { settlement, tx: toBase64(txBytes) }, context))
        .then(async (res) => {
          if (res.status !== 202) {
            // ⚠️ 202 is the only accepting status, so a `200 {ok:false}` failure lands here as
            // intended — that is the shape a genuine failure takes rather than a 5xx whose body the
            // tunnel would replace (`sponsor-failure.ts`).
            const detail = await res.text().catch(() => '');
            const reason = sponsorFailureReason(detail);
            throw new Error(
              reason === undefined ? `sponsor rejected ${res.status} (no body)` : `sponsor rejected: ${reason}`,
            );
          }
          // The sponsor host answers a transfer with where it landed; every other kind answers a bare
          // 202. Passed through so the origin can hand the device a real handle rather than a
          // promise that it went somewhere.
          const body = await res.text();
          let landed: { txId?: unknown } = {};
          try {
            landed = JSON.parse(body) as { txId?: unknown };
          } catch (error: unknown) {
            // A 202 with no JSON body is a sponsor host older than the transfer-outcome change, which
            // is supported. Said once rather than swallowed, so "no id" and "unreadable" stay apart.
            options.log(`sponsor accepted without a readable body: ${error instanceof Error ? error.message : String(error)}`);
          }
          return {
            accepted: true as const,
            ...(typeof landed.txId === 'string' && landed.txId.length > 0 ? { txId: landed.txId } : {}),
          };
        })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          options.log(
            `forwarding submitProven failed: ${message}` +
              `${context?.requestId === undefined ? '' : ` req=${context.requestId}`}` +
              `${context?.network === undefined ? '' : ` network=${context.network}`}`,
          );
          // The sponsor never accepted it, so nothing will ever settle this ref — say so instead of
          // leaving a pending badge that waits forever.
          await applySettlement(options.store, settlement, { status: 'failed', error: message }).catch(() => {});
          // ⚠️ Returned, never rethrown. A caller that hands this to `keepAlive` and walks away must not
          // produce an unhandled rejection, and a caller that awaits it wants the reason rather than a
          // throw to translate.
          return { accepted: false as const, error: message };
        });
      // Handed to the runtime *and* returned. `keepAlive` is what keeps a Worker from cancelling a
      // forward it is not waiting for; the return value is for the caller that chooses to wait.
      if (context?.keepAlive !== undefined) context.keepAlive(forwarding);
      return forwarding;
    },
    contractState: () =>
      Promise.reject(new Error('contract state is read from an indexer, not from this service')),
    identityRow: options.identityRow,
    submitIdentityRow: async (txBytes, context) => {
      const res = await post('/internal/register', { tx: toBase64(txBytes) }, context);
      // ⚠️ 202 is the only accepting status. A genuine failure answers `200 {ok:false}` on purpose —
      // see `sponsor-failure.ts` — so this must never widen to "any 2xx".
      if (res.status !== 202) {
        const detail = await res.text().catch(() => '');
        const reason = sponsorFailureReason(detail);
        // Logged as well as thrown, like submitProven's failure path: the caller only sees the status, and
        // a Cloudflare-generated error carries its reason in headers rather than in the body. `req` is the
        // value the sponsor logs too, so the two halves of this failure can be joined without wall-clock
        // guessing; the `cf-ray` below is the *response's*, which is Cloudflare's own and differs.
        options.log(
          `forwarding submitIdentityRow failed: ${res.status} ${reason ?? '(no body)'} [network=${
            context?.network ?? 'default'
          } req=${
            context?.requestId ?? 'none'
          } cf-ray=${res.headers.get('cf-ray') ?? 'none'} cf-mitigated=${
            res.headers.get('cf-mitigated') ?? 'none'
          } server=${res.headers.get('server') ?? 'none'}]`,
        );
        // The reason leads when there is one: it is what a retry predicate and a user-facing message
        // both read, and a status code in front of it is what made "error code: 502" the whole story.
        throw new Error(
          reason === undefined
            ? `sponsor rejected the registration (${res.status}, no body)`
            : `sponsor rejected the registration: ${reason}`,
        );
      }
    },
    // The queue lives on the sponsor host, so there is nothing local to drain.
    whenIdle: () => Promise.resolve(),
  };
};

const applyPending = (
  store: Pick<
    ContentStore,
    'getCircle' | 'setCircleChain' | 'setMembershipChain' | 'setProposalChain' | 'setVoteChain' | 'confirmCircleInvite'
  >,
  settlement: ProvenSettlement,
): Promise<void> => applySettlement(store, settlement, { status: 'pending' });

/**
 * Write a settlement outcome to the content store.
 *
 * Exported because the Worker's `/internal/settle` route applies exactly this to what the sponsor
 * reports — the same function for the local mark and the remote report, so the two cannot diverge in
 * how a kind maps to a row.
 */
export const applySettlement = async (
  store: Pick<
    ContentStore,
    'getCircle' | 'setCircleChain' | 'setMembershipChain' | 'setProposalChain' | 'setVoteChain' | 'confirmCircleInvite'
  >,
  settlement: ProvenSettlement,
  chain: ChainRef,
): Promise<void> => {
  switch (settlement.kind) {
    case 'circle': {
      await store.setCircleChain(settlement.circleId, chain);
      // ⚠️ The founder's **membership** settles with the deploy, because `circle.compact`'s constructor
      // seats their leaf in `members` — there is no separate join transaction to settle it any more.
      // Without this their membership reads as never-on-chain while the contract says otherwise.
      const founderSubject = (await store.getCircle(settlement.circleId))?.founderSubject;
      if (founderSubject !== undefined) {
        await store.setMembershipChain(settlement.circleId, founderSubject, chain);
      }
      return;
    }
    case 'membership':
      return store.setMembershipChain(settlement.circleId, settlement.subject, chain);
    case 'proposal':
      return store.setProposalChain(settlement.proposalId, chain);
    case 'vote':
      return store.setVoteChain(settlement.proposalId, settlement.subject, chain);
    case 'invite':
      // Only `confirmed` promotes it. A pending or failed `setInvite` must leave the invite
      // undispensable: handing out a code whose commitment is not on the ledger produces a join
      // that fails with "no such invite", which the recipient can neither act on nor distinguish
      // from being refused.
      return chain.status === 'confirmed'
        ? store.confirmCircleInvite(settlement.circleId, settlement.commitment)
        : Promise.resolve();
    case 'transfer':
    case 'invite-authority':
      // Neither has a row — see ProvenSettlement. Resolving rather than throwing: the sponsor still
      // reports the outcome, and a report with nothing to file is not an error.
      //
      // ⚠️ For `invite-authority` in particular, the temptation is to cache "this circle delegated"
      // here. It must not: only the contract's `inviteAuthority` cell says whether a delegation is
      // live, and a cache would keep claiming so after a founder withdrew it on chain.
      return Promise.resolve();
  }
};

/**
 * Validate a settlement report from the sponsor.
 *
 * The sponsor is our own host behind a shared secret, but the report still names a row to write, so it
 * is checked rather than trusted: a malformed kind must be a 400, not an exception in a route that has
 * already accepted the transaction.
 */
export const parseSettlementReport = (
  raw: unknown,
): { settlement: ProvenSettlement; chain: ChainRef } | { error: string } => {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be an object' };
  const { settlement, chain } = raw as { settlement?: unknown; chain?: unknown };
  if (typeof settlement !== 'object' || settlement === null) return { error: 'settlement is required' };
  if (typeof chain !== 'object' || chain === null) return { error: 'chain is required' };
  const s = settlement as { kind?: unknown; circleId?: unknown; proposalId?: unknown; subject?: unknown };
  const c = chain as { status?: unknown };
  if (c.status !== 'pending' && c.status !== 'confirmed' && c.status !== 'failed') {
    return { error: 'chain.status must be pending, confirmed or failed' };
  }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : undefined);
  switch (s.kind) {
    case 'circle': {
      const circleId = str(s.circleId);
      return circleId === undefined
        ? { error: 'circle report requires circleId' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'membership': {
      return str(s.circleId) === undefined || str(s.subject) === undefined
        ? { error: 'membership report requires circleId and subject' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'proposal': {
      return str(s.proposalId) === undefined
        ? { error: 'proposal report requires proposalId' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'vote': {
      return str(s.proposalId) === undefined || str(s.subject) === undefined
        ? { error: 'vote report requires proposalId and subject' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'invite': {
      const commitment = str((s as { commitment?: unknown }).commitment);
      return str(s.circleId) === undefined || commitment === undefined || !/^[0-9a-f]{64}$/.test(commitment)
        ? { error: 'invite report requires circleId and a 64-hex commitment' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'invite-authority': {
      // ⚠️ **Every kind added to `ProvenSettlement` has to be added here too.** This validator is a
      // separate switch from `applySettlement`'s, guarding the *inward* report, so a kind the outward
      // path knows and this one does not is accepted, submitted, landed — and then the host's report
      // is refused with `unknown settlement kind`, leaving the row saying `pending` for ever. That is
      // exactly what `invite-authority` did on its first run.
      return str(s.circleId) === undefined
        ? { error: 'invite-authority report requires circleId' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    case 'transfer': {
      return str(s.subject) === undefined
        ? { error: 'transfer report requires subject' }
        : { settlement: settlement as ProvenSettlement, chain: chain as ChainRef };
    }
    default:
      return { error: `unknown settlement kind ${JSON.stringify(s.kind)}` };
  }
};
