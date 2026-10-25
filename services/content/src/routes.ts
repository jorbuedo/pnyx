// WHATWG fetch-style router so the same handler runs under Bun.serve, tests, or any
// future runtime. CORS is wide open for the spike — the login flow is same-origin in
// production and this narrows before any real deployment.
//
// Authorization model: reads are public; every write requires a session (JWT subject)
// AND membership in the target circle. Content responses carry persona labels only —
// subjects never leave the auth endpoints.
import { readFile } from 'node:fs/promises';
import { SignJWT, importJWK, jwtVerify } from 'jose';
import type { ArtifactService } from './artifacts.js';
import { acceptBugReport, BUG_REPORT_HEADERS, type BugReportPorts } from './bug-report.js';
import { type AuthConfig, type IdentityLoginRequest, identityLogin, verifyDeviceBinding } from './auth.js';
import type { ChainMirror, ProvenSettlement } from './chain.js';
import type { McpPairingService } from './mcp-pairing.js';
import type { Notifier } from './notifications.js';
import { isConversationBetween } from '@pnyx/contract-client/dm-conversation';
import { inviteCommitment } from '@pnyx/contract-client/circle-derivations';
import { encodeCircleInvite } from '@pnyx/contract-client/circle-invite';
import { claimWindowStart, mayClaim } from './dm-claim-limit.js';
import { DEFAULT_DM_POLICY, decideConsent, isDmPolicy, type PermitState } from './dm-consent.js';
import { issuePermit, PERMIT_MAX_TTL_SECONDS, verifyPermit } from './dm-permit.js';
import { noRateLimit, type RateLimiter, rateLimitKey } from './rate-limit.js';
import { neverThrows, noRealtime, type RealtimePublisher } from './realtime.js';
import { circleTemplate } from './circle-template.js';
import { applySettlement, parseSettlementReport, type SponsorLink } from './sponsor-client.js';
import { chainProbe, sponsorProbe, storeProbe } from './status-probes.js';
import {
  accountSatisfiesAny,
  inviteChallengePayload,
  type InvitePredicate,
  invitePredicateParam,
  parseInvitePredicates,
} from './circle-invite-policy.js';
import type { AccountLookup } from './koios-account.js';
import { collectStatus, prefersHtml, renderStatusHtml } from './status.js';
import type { Circle, ContentStore } from './store.js';

/**
 * What the invite attestor needs from the outside world.
 *
 * A port rather than direct calls, for the reason `bug-report.ts` states: the decision logic is
 * worth testing without a network, and the two things it reaches for — a signature verifier and a
 * chain read — are exactly the two a test wants to drive.
 */
export type InviteAttestorPorts = {
  /** CIP-8 P1+P2: the payload is what we asked for, AND the key owns the address. */
  readonly verify: (params: {
    readonly signatureHex: string;
    readonly keyHex: string;
    readonly addressHex: string;
    readonly expectedPayload: string;
  }) => Promise<boolean>;
  /** The stake account's delegation and balance, or why we could not ask. */
  readonly accountFacts: (stakeAddressBech32: string) => Promise<AccountLookup>;
  /**
   * The commitment a founder posts with `setInviteAuthority` to delegate this circle's invites to us.
   *
   * Derived per circle on the sponsor host, which holds the root — this service never sees it. Pure on
   * that side, so it answers while the sponsor's wallet is still cold-syncing: delegating is the first
   * thing a founder does and it needs no wallet.
   */
  readonly authorityCommitment: (circleId: string) => Promise<string>;
  /**
   * Put one commitment into a circle's on-chain `invites`, and resolve when it is there.
   *
   * ⚠️ **Awaited, not queued.** The caller is holding a claimant's request open and about to hand them
   * a code; a code returned before its commitment is on chain fails at `join` with "no such invite",
   * which the recipient cannot act on and cannot tell apart from being refused.
   *
   * `'not-delegated'` is its own outcome rather than an error because it is the one failure the
   * *founder* can fix and the claimant cannot — the same distinction `409` carried when the pool ran
   * dry, which is what this replaced.
   */
  readonly mint: (input: {
    readonly circleId: string;
    readonly contractAddress: string;
    readonly commitment: string;
  }) => Promise<'issued' | 'not-delegated'>;
};

export type ServiceContext = {
  readonly auth: AuthConfig;
  readonly publicJwk: Record<string, unknown>;
  readonly store: ContentStore;
  /** Dev-mode login without a wallet (POST /auth/dev). Never enable on a public deployment. */
  readonly devAuth: boolean;
  readonly chain: ChainMirror;
  /** Push-notification intent production + device fan-out (notifications.ts). */
  readonly notify: Notifier;
  /** Circuit-artifact manifest + file serving for on-device proving; absent when chain disabled. */
  /**
   * Circuit artifacts per contract target (`identity`, `circle`). Absent when the chain is off.
   *
   * A record rather than one service because the split gave the app two contracts to prove against,
   * with disjoint circuit sets (`docs/CONTRACT_TOPOLOGY.md`).
   */
  readonly artifacts?: Readonly<Record<string, ArtifactService>>;
  /**
   * Guards `POST /register`, the one unauthenticated route that spends sponsor DUST. Absent means
   * unlimited, which is only right for a test — both real entry points install one.
   */
  readonly registerLimit?: RateLimiter;
  /**
   * Bounds sponsored value transfers per authenticated caller. Absent means unlimited, which is only
   * correct for a deployment whose sponsor funds nothing (`SPONSOR_FUND_TRANSFERS` off).
   */
  readonly transferLimit?: RateLimiter;
  /**
   * Shared secret the sponsor host authenticates its settlement reports with (`POST
   * /internal/settle`). Absent → the route is refused outright, so a deployment with no sponsor never
   * accepts a write to a ChainRef from anywhere.
   */
  readonly sponsorToken?: string;
  /**
   * Bug-report intake backends (`src/bug-report.ts`). Absent → `POST /bug-report` is 404, which
   * is the honest state for a deployment with no R2 bucket bound rather than a 500 at upload time.
   */
  readonly bugReports?: BugReportPorts;
  /** Bounds bug-report uploads per caller. Absent means unlimited, correct only for a test. */
  readonly bugReportLimit?: RateLimiter;
  /**
   * The self-service invite attestor: CIP-8 verification and the Cardano read its predicates need.
   *
   * Absent → the `/circles/:id/invite*` routes are 404, which is the honest state for a deployment
   * with no `KOIOS_URL` configured, or with no sponsor host to mint through. The alternative — falling back to a public Koios —
   * is forbidden by the repo's third-party RPC policy and would turn a config mistake into
   * intermittent wrong verdicts about people's wallets.
   */
  readonly inviteAttestor?: InviteAttestorPorts;
  /**
   * How `GET /status` reaches the sponsor host. Separate from {@link RouteContext.sponsorToken}, which
   * authenticates reports coming *inward*; this is the outward direction and needs the URL too. Absent →
   * the status page reports the sponsor as `unknown` rather than inventing a health it cannot observe.
   */
  readonly sponsorLink?: SponsorLink;
  /**
   * Wakes a subject's open sockets when something it is watching changes. Absent → nothing is
   * published and clients fall back to polling, which is the Node/dev composition (no Durable Objects).
   */
  readonly realtime?: RealtimePublisher;
  /**
   * Agent credentials for the MCP relay. Absent → the pairing routes are 404, so a deployment without
   * a database or a relay never pretends to issue one.
   */
  readonly mcpPairings?: McpPairingService;
};

/**
 * A settlement kind nobody decided about.
 *
 * `never` rather than a comment: this is a switch over a union that grows, and the cost of a missed
 * case is a signal that is never sent — which looks exactly like a working system.
 */
const assertNeverSettlement = (settlement: never): void => {
  console.log(`[realtime] no publish rule for settlement ${JSON.stringify(settlement)}`);
};

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  // ⚠️ `DELETE` is here because a route uses it (forgetting a revoked pairing). A method missing from
  // this list fails the browser's preflight, so the request is never sent and the only thing anyone
  // sees is "CORS error" — the app on a device would not notice, and the web build would break.
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
} as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders,
    },
  });

// CORS preflight. Must be a genuinely body-less 204 — `new Response(body, {status: 204})`
// with any non-null body (including the string "null") throws in the Workers/Fetch
// runtime, which surfaced as a 500 on every browser preflight and blocked the web client.
const preflight = (): Response => new Response(null, { status: 204, headers: corsHeaders });

/**
 * The `{ids: [...]}` body every "remove these rows" route takes.
 *
 * Returns the ids, or a **string** explaining the refusal — one validation shape rather than four
 * copies that drift apart, which is how one route ends up accepting what another rejects.
 */
const idList = (body: unknown): string[] | string => {
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array';
  if (ids.length > 500) return 'at most 500 ids per request';
  if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    return 'each id must be a non-empty string of at most 128 characters';
  }
  return ids as string[];
};

const binary = (bytes: Uint8Array, filename: string): Response =>
  // Uint8Array is generic over its buffer since TS 5.7, and BodyInit only accepts an
  // ArrayBuffer-backed view. Re-wrapping is a view, not a copy of the bytes.
  new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * A fresh invite secret — 32 bytes, the width `circle.compact`'s `inviteSecret` witness takes.
 *
 * ⚠️ **This is a capability, not an identifier.** Whoever holds it joins the circle once, so it comes
 * from the CSPRNG and nothing else: the chain stores only `inviteCommitment(secret)`, a one-way hash,
 * and an invite guessable from a counter or a timestamp is a gate that is not one.
 *
 * ⚠️ **Hex here, bech32m on the wire.** The row and the commitment take the raw bytes, but a caller
 * is handed `encodeCircleInvite(...)` — the `pnyx_invite1…` spelling is the only one the app's join
 * field decodes, and returning the hex made a successfully minted invite die in the requester's
 * client with a bech32 charset error.
 */
const randomSecretHex = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Base64 for the DM routes' opaque MLS payloads. JSON+base64 rather than raw binary bodies so a
 * request stays inspectable in a log or a curl, at ~33% overhead on ciphertext that is already small.
 *
 * `fromBase64` returns undefined rather than throwing on anything malformed — a bad body is a 400,
 * not a 500. `atob`/`btoa` are present in both Workers and Node 18+.
 */
const toBase64 = (bytes: Uint8Array): string => {
  let binaryString = '';
  for (const byte of bytes) binaryString += String.fromCharCode(byte);
  return btoa(binaryString);
};

const fromBase64 = (value: unknown): Uint8Array | undefined => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) {
    return undefined;
  }
  try {
    const binaryString = atob(value);
    const out = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) out[i] = binaryString.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
};

/** Fixed-length hex → bytes, or undefined for anything malformed (a 400, never a 500). */
/** Content hash used as a KeyPackage's id, which is what makes re-upload idempotent. */
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));

/**
 * The Midnight network a `/chain/submit` names, or `undefined` for "the sponsor host's default".
 *
 * ⚠️ **Validated for shape, not for existence.** Which networks a host actually sponsors is the host's
 * own fact, and it answers by name (`this host does not sponsor 'preview'; it sponsors preprod`) — a
 * second list here would be a copy to drift. What is refused here is a value that could not be a
 * network id at all, so a caller sending an object or 200 characters of junk hears it from the service
 * that read it rather than from a proxy hop.
 */
const readNetwork = (value: unknown): { network?: string } | { error: string } => {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
    return { error: '`network` must be a Midnight network id, e.g. "preview", "preprod" or "mainnet"' };
  }
  return { network: value };
};

const text = (value: unknown, max = 2000): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

/**
 * Whether this subject holds the circle's founder authority.
 *
 * ⚠️ **Anchored to the circle's settled deploy, not to a content-plane label.** `founderSubject` is
 * the subject that settled this circle's contract and named its `founderLeaf` — the persona its
 * constructor seats in `moderators`. Only the creator can reach that route, so this is authority
 * derived from the deploy rather than from a string chosen at row creation.
 *
 * The label comparison remains for circles settled before that was recorded, or never settled at all:
 * it is what they have always used, and dropping it would lock their own creators out. That path
 * closes as those circles are re-settled.
 *
 * ⚠️ **What neither path covers is a moderator added later by `addModerator`.** Establishing that a
 * *session* owns a given leaf is what the contract's `moderatorAuth` map now exists to answer — a
 * moderator signs a request and this checks the signature against the key their promotion recorded.
 * Until that is wired here, a circle's effective moderator set is exactly its founder.
 *
 * Extracted when a third caller appeared (create channel, circle display, rename channel): three
 * verbatim copies of an authority rule is how one of them silently drifts.
 */
const holdsFounderAuthority = (
  circle: { readonly author: string; readonly founderSubject?: string },
  membership: { readonly persona: string },
  subject: string,
): boolean =>
  circle.founderSubject === undefined ? membership.persona === circle.author : circle.founderSubject === subject;

/**
 * Audience for realtime tickets, distinct from the session audience so the two token kinds cannot
 * stand in for each other. Exported because the Worker verifies the ticket on upgrade.
 */
export const REALTIME_AUDIENCE = 'pnyx-realtime';

/**
 * How many grapheme clusters a string has — what "one character" means to a reader.
 *
 * Code points are the wrong unit here: 👩🏽‍🚀 is five of them and one character, and counting them
 * would reject exactly the emoji this field exists to allow.
 *
 * ⚠️ The fallback over-counts rather than under-counts. A runtime without `Intl.Segmenter` refuses a
 * valid ZWJ emoji instead of accepting a five-character string — the safe direction for a bound.
 */
const graphemeCount = (value: string): number => {
  const segmenter = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } })
    .Segmenter;
  if (segmenter === undefined) return [...value].length;
  return [...new segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
};

export const createHandler = (ctx: ServiceContext) => {
  // Wrapped once, here, so every publish below is safe by construction rather than by each call site
  // remembering. See `neverThrows`.
  const realtime = neverThrows(ctx.realtime ?? noRealtime, (m) => console.log(`[realtime] ${m}`));

  const issueJwt = (subject: string) =>
    new SignJWT({ network: ctx.auth.network })
      // kid lets a JWKS consumer pick the right key; derived from the key itself in createJwtKeys.
      .setProtectedHeader({ alg: 'ES256', ...(ctx.auth.jwt.kid ? { kid: ctx.auth.jwt.kid } : {}) })
      .setSubject(subject)
      .setIssuer(ctx.auth.jwt.issuer)
      .setAudience(ctx.auth.jwt.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ctx.auth.jwt.ttlSeconds)
      .sign(ctx.auth.jwt.privateKey);

  /**
   * Resolve the consent question for one delivery: may `sender` reach `recipient`, and does it buzz?
   *
   * Reads the three settings, verifies whatever permit was presented, and hands the decision to
   * `decideConsent` — which is where the rule lives, so it can be read and tested on its own.
   *
   * ⚠️ **Auto-issue happens here, not in the rule.** Under an `open` policy a stranger's first
   * delivery mints a permit for the pair, because otherwise that conversation has no id and the
   * recipient could never mute it. The token goes back to the sender, whose client presents it from
   * then on.
   */
  const resolveConsent = async (
    recipient: string,
    sender: string,
    presented: string | undefined,
  ): Promise<
    | { readonly ok: false; readonly reason: 'blocked' | 'closed' | 'permit-required' }
    | { readonly ok: true; readonly notify: boolean; readonly jti?: string; readonly issued?: string }
  > => {
    const [policy, blocked] = await Promise.all([
      ctx.store.readDmPolicy(recipient),
      ctx.store.isDmPeerBlocked(recipient, sender),
    ]);
    let permit: PermitState = { kind: 'none' };
    let jti: string | undefined;
    if (presented !== undefined) {
      const verified = await verifyPermit(ctx.publicJwk, presented, {
        issuer: recipient,
        presentedBy: sender,
        signedBy: ctx.auth.jwt.issuer,
      });
      if (verified !== undefined) {
        jti = verified.jti;
        const revokedAt = await ctx.store.readDmPermitRevocation(verified.jti);
        // A cutoff, not a flag: a permit minted after the revocation is a deliberate unmute.
        const silenced = revokedAt !== undefined && verified.issuedAt * 1000 <= Date.parse(revokedAt);
        if (verified.bearer === undefined && silenced) {
          // ⚠️ **A revoked invite is a closed door, not a mute.** `revoked` means "muted" for a
          // targeted permit — the sender was admitted and is being silenced. An invite admits
          // nobody in particular, so revoking it means the link no longer works, and treating it as
          // a mute would deliver every stranger's message silently instead of refusing them. Read
          // as "no permit presented", which the policy then answers.
          permit = { kind: 'none' };
        } else if (verified.bearer === undefined) {
          // ⚠️ **Whether an invite converts is the policy's call, not this function's** — converting
          // admits somebody new, and `closed` admits nobody new. Handed on unconverted so the rule
          // decides; minting here regardless is what used to admit a stranger under `closed` while
          // also signing a token that was then discarded.
          permit = { kind: 'invite', notify: verified.notify };
        } else {
          permit = silenced ? { kind: 'revoked' } : { kind: 'valid', notify: verified.notify };
        }
      }
    }
    const decision = decideConsent({ policy: policy ?? DEFAULT_DM_POLICY, blocked, permit });
    if (!decision.deliver) {
      console.log(`[dm] delivery refused: ${decision.reason}`);
      return { ok: false, reason: decision.reason };
    }
    if (decision.convert) {
      // ⚠️ **An invite is converted, not kept.** It names nobody, so presenting it again would let
      // anyone who ever saw the link keep reaching this recipient — and it would give the recipient
      // no per-person id to mute. Converting mints a targeted permit for *this* sender, which is
      // what makes them individually muteable and blockable from here on. Revoking the invite stops
      // future conversions; it deliberately does not un-admit the people who already converted,
      // since their permits carry their own ids.
      const converted = await issuePermit(
        {
          privateKey: ctx.auth.jwt.privateKey,
          issuer: ctx.auth.jwt.issuer,
          ...(ctx.auth.jwt.kid ? { kid: ctx.auth.jwt.kid } : {}),
        },
        { issuer: recipient, bearer: sender, notify: decision.notify },
      );
      return { ok: true, notify: decision.notify, jti: converted.permit.jti, issued: converted.token };
    }
    if (!decision.autoIssue) {
      return { ok: true, notify: decision.notify, ...(jti === undefined ? {} : { jti }) };
    }
    const minted = await issuePermit(
      { privateKey: ctx.auth.jwt.privateKey, issuer: ctx.auth.jwt.issuer, ...(ctx.auth.jwt.kid ? { kid: ctx.auth.jwt.kid } : {}) },
      { issuer: recipient, bearer: sender },
    );
    return { ok: true, notify: decision.notify, jti: minted.permit.jti, issued: minted.token };
  };

  /** The permit a request presents, if any. A header so it rides every delivery without a body change. */
  const presentedPermit = (request: Request): string | undefined =>
    text(request.headers.get('x-pnyx-dm-permit'), 4096);

  /** What a refusal says. Deliberately the same shape for every reason a caller could learn from. */
  const consentRefusal = (reason: 'blocked' | 'closed' | 'permit-required'): Response =>
    reason === 'permit-required'
      ? json({ error: 'that identity accepts messages by permit only', reason }, 403)
      : json({ error: 'that identity is not accepting messages from you', reason: 'refused' }, 403);

  const subjectOf = async (request: Request): Promise<string | undefined> => {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }
    try {
      const key = await importJWK(ctx.publicJwk as never, 'ES256');
      const { payload } = await jwtVerify(header.slice(7), key, {
        issuer: ctx.auth.jwt.issuer,
        audience: ctx.auth.jwt.audience,
        algorithms: ['ES256'],
      });
      return typeof payload.sub === 'string' ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  };

  /** Persona choice for create/join: explicit pseudonym, or disclosed = the subject itself. */
  const personaChoice = (subject: string, body: { persona?: unknown }): { persona: string; disclosed: boolean } | undefined => {
    if (body.persona === undefined || body.persona === null || body.persona === '') {
      return { persona: subject, disclosed: true };
    }
    const persona = text(body.persona, 40);
    if (!persona) {
      return undefined;
    }
    return { persona, disclosed: persona === subject };
  };

  /**
   * Wake everyone whose view of a settled ref just changed.
   *
   * A circle or proposal landing on chain is visible to the whole circle, so the badge has to flip for
   * every member rather than only for whoever submitted. A membership or vote ref is that subject's
   * own, and publishing it circle-wide would tell other members when a specific person voted — which
   * the content plane deliberately does not reveal.
   */
  /**
   * A circle as the API may return it.
   *
   * ⚠️ **`founderSubject` never leaves the service.** It is a subject — the founder's `C` — and every
   * other subject in this store is service-side only for the same reason. Leaking it here would tie a
   * circle's creator to their identity even when they chose a display-name persona precisely so it
   * would not be, which is the linkage the whole persona design exists to prevent. Stripped in one
   * place rather than per response, so a new circle endpoint cannot forget.
   */
  const publicCircle = <T extends { founderSubject?: string; codeDigest?: string }>(circle: T) => {
    const { founderSubject: _withheld, codeDigest, ...rest } = circle;
    // The verdict travels, not the digest: a client cannot compare it to anything this deployment
    // has not told it, and `template` is the question it actually needs answered.
    return {
      ...rest,
      template: circleTemplate({ codeDigest, currentDigest: ctx.chain.circleCodeDigest }),
    };
  };

  /**
   * Fill in a circle's contract digest the first time anyone reads it.
   *
   * Lazily rather than on every read: the digest is a property of a contract that can never change,
   * so one lookup answers for ever. Lazily rather than at settlement, because the circles that most
   * need the verdict are the ones deployed before this existed.
   *
   * ⚠️ **A failed lookup writes nothing.** "The indexer was unreachable" is not a template verdict,
   * and recording it as one would permanently mislabel a healthy circle.
   */
  const resolveCircleTemplate = async (circle: Circle): Promise<void> => {
    if (circle.codeDigest !== undefined || circle.chain?.status !== 'confirmed') return;
    const address = circle.chain.chainId;
    if (address === undefined) return;
    try {
      const digest = await ctx.chain.contractCodeDigestAt(address);
      if (digest !== undefined) await ctx.store.setCircleCodeDigest(circle.id, digest);
    } catch (error) {
      console.log(`[circles] could not resolve the contract digest for ${circle.id}: ${String(error)}`);
    }
  };

  const publishSettlement = async (settlement: ProvenSettlement): Promise<void> => {
    switch (settlement.kind) {
      case 'circle': {
        // In parallel: N members means N subrequests, and serialising them would put the whole circle's
        // fan-out on the settlement report's latency. ⚠️ Ceiling worth knowing — a DO stub call is a
        // subrequest to a Cloudflare service, capped at 1000 per invocation on our free plan (the 50
        // cap is for *external* subrequests and does not apply here). So this binds at a 1000-member
        // circle, and the publisher swallows failures, so it would present as missing signals rather
        // than an error. `docs/mobile-shell-plan.md` item 11 has the fix, which is not hub-per-circle.
        const members = await ctx.store.listMemberSubjects(settlement.circleId);
        await Promise.all(
          members.map((subject) => realtime.publish(subject, { kind: 'chain-settled', communityId: settlement.circleId })),
        );
        return;
      }
      case 'membership': {
        await realtime.publish(settlement.subject, { kind: 'chain-settled', communityId: settlement.circleId });
        return;
      }
      case 'proposal': {
        const proposal = await ctx.store.getProposal(settlement.proposalId);
        if (proposal === undefined) return;
        const members = await ctx.store.listMemberSubjects(proposal.circleId);
        await Promise.all(
          members.map((subject) =>
            realtime.publish(subject, {
              kind: 'proposal-changed',
              communityId: proposal.circleId,
              proposalId: settlement.proposalId,
            }),
          ),
        );
        return;
      }
      case 'vote': {
        const proposal = await ctx.store.getProposal(settlement.proposalId);
        if (proposal === undefined) return;
        await realtime.publish(settlement.subject, {
          kind: 'proposal-changed',
          communityId: proposal.circleId,
          proposalId: settlement.proposalId,
        });
        return;
      }
      case 'transfer': {
        // ⚠️ **Nothing is published yet, and that is a known hole, not a decision.** A transfer's
        // outcome — including a chain *rejection* — currently reaches nobody: the sender is told the
        // service accepted the bytes and never learns whether they landed. Observed on preprod: a
        // send rejected with `Custom error: 168` while the app reported success.
        //
        // The subject is right here, and the realtime plane is per-subject, so the channel exists.
        // What is missing is an event kind for it and an app-side consumer.
        return;
      }
      case 'invite':
        // Nothing to wake. An invite landing changes what the *founder* can hand out, and the founder
        // is the one who just submitted it — they learn the outcome from their own request. No
        // member's view of the circle changed, and waking every member because a code was minted
        // would leak the existence and timing of invites to people who were never offered one.
        return;
      case 'invite-authority':
        // Nothing to wake either, and for a stronger reason: who a circle delegates its gate to is
        // between its founder and the contract. A member learns nothing from it, and a would-be
        // joiner reads the entry rule from `/invite-policy` rather than from a push.
        return;
      default:
        // Exhaustive: a new settlement kind must decide what it wakes, and say so here. Without this
        // the `transfer` kind was added and simply published nothing, silently — the switch compiled
        // clean because an unhandled case just falls out of the function.
        return assertNeverSettlement(settlement);
    }
  };

  /**
   * Resolve + authorize a POST /chain/submit `ref` into a ProvenSettlement. Content-plane guard
   * only (the contract enforces membership cryptographically on-chain): the caller may flip the
   * ChainRef of an entity it is associated with. membership/vote settle the caller's OWN subject
   * (taken from the token, never the body); proposal/vote require membership in the target circle.
   */
  const resolveSettlement = async (
    raw: unknown,
    subject: string,
  ): Promise<{ settlement: ProvenSettlement } | { error: string; status: number }> => {
    if (typeof raw !== 'object' || raw === null) {
      return { error: 'ref is required ({kind, ...ids})', status: 400 };
    }
    const ref = raw as {
      kind?: unknown;
      circleId?: unknown;
      proposalId?: unknown;
      chainId?: unknown;
      founderLeaf?: unknown;
      commitment?: unknown;
    };
    // ⚠️ **64, and validated.** A contract address is 32 bytes — 64 hex characters — and the cap here
    // was 40, so `text` returned `undefined` for every real address and `chainId` was dropped from
    // every settlement ever recorded. Nothing said so: the settlement still confirmed, the badge still
    // read "On-chain", and the address the app needs to prove *against* the circle silently went
    // missing. A non-founder's join then had no contract to target and landed content-plane only,
    // making them a member the chain had never heard of.
    //
    // Refused rather than dropped when malformed, because that is the failure mode this line already
    // demonstrated: a value quietly discarded is one nobody notices for a month.
    if (ref.chainId !== undefined && !/^[0-9a-f]{64}$/.test(text(ref.chainId, 64) ?? '')) {
      return { error: 'chainId must be 64 lowercase hex characters', status: 400 };
    }
    const chainId = text(ref.chainId, 64);
    switch (ref.kind) {
      case 'circle': {
        const circleId = text(ref.circleId, 80);
        if (!circleId) return { error: 'circle ref requires circleId', status: 400 };
        const circle = await ctx.store.getCircle(circleId);
        if (!circle) return { error: 'no such circle', status: 404 };
        // ⚠️ **Only the circle's creator may say which contract it is.** This case checked existence
        // alone — not membership, unlike every neighbouring kind — while `chainId` is a value the
        // *client* asserts and `setCircleChain` writes through, last-write-wins.
        //
        // That was exploitable. `circleId = SHA-256("pnyx:circle-id" ‖ contentCircleId)` is a public
        // function of a public id, and a circle's address derives from `(circleId, isOpen, founder)` —
        // so anyone could deploy a well-formed circle contract for someone else's circle with
        // themselves as founder (a different address, since the founder feeds it) and report that
        // address here. The app would then show the circle "On-chain" pointing at a contract whose
        // only moderator is the attacker, and every later joiner would join *that* contract.
        //
        // The creator is the right bar: `author` is set once at creation and never changes, persona
        // labels are unique per circle, and the caller's own label comes from their authenticated
        // subject rather than from this request.
        const membership = await ctx.store.getMembership(circleId, subject);
        if (!membership || membership.persona !== circle.author) {
          return { error: 'only the circle’s creator can settle its contract address', status: 403 };
        }
        // The circle's on-chain founder — the persona its constructor seats in `moderators`, and so
        // its entire moderation authority (`addModerator` has no caller on any rail).
        //
        // ⚠️ **One row per circle, deliberately, and not one per member.** Knowing which *session*
        // owns a member leaf would mean recording `C` → persona commitment for everybody at join —
        // the only moment the chain proves that link — and that is precisely the linkage personas
        // exist to prevent. The founder is the one leaf worth naming, and naming it costs nothing
        // about anyone else.
        //
        // Self-asserted on a route only the creator can call, so a wrong value misdirects only their
        // own circle — and it is checkable rather than merely trusted: the address is a hash over
        // `(circleId, isOpen, founder)`, so a client with the native rail re-derives it and refuses a
        // circle whose two assertions disagree.
        const founderLeaf = ref.founderLeaf === undefined ? undefined : text(ref.founderLeaf, 64);
        if (ref.founderLeaf !== undefined && (founderLeaf === undefined || !/^[0-9a-f]{64}$/.test(founderLeaf))) {
          return { error: 'founderLeaf must be 64 lowercase hex characters', status: 400 };
        }
        if (founderLeaf !== undefined) {
          // The subject rides along: only the creator reaches this line, so recording who settled the
          // deploy is what lets channel authority be anchored to the circle's on-chain founder rather
          // than to a content-plane label. It is a subject the service already holds as a member.
          await ctx.store.setCircleFounder(circleId, founderLeaf, subject);
        }
        return { settlement: { kind: 'circle', circleId, ...(chainId === undefined ? {} : { chainId }) } };
      }
      case 'membership': {
        const circleId = text(ref.circleId, 80);
        if (!circleId) return { error: 'membership ref requires circleId', status: 400 };
        if (!(await ctx.store.getCircle(circleId))) return { error: 'no such circle', status: 404 };
        if (!(await ctx.store.getMembership(circleId, subject))) {
          return { error: 'join the circle before settling its membership on-chain', status: 403 };
        }
        return { settlement: { kind: 'membership', circleId, subject } };
      }
      case 'proposal': {
        const proposalId = text(ref.proposalId, 80);
        if (!proposalId) return { error: 'proposal ref requires proposalId', status: 400 };
        const proposal = await ctx.store.getProposal(proposalId);
        if (!proposal) return { error: 'no such proposal', status: 404 };
        if (!(await ctx.store.getMembership(proposal.circleId, subject))) {
          return { error: 'join the circle to settle its proposals on-chain', status: 403 };
        }
        return { settlement: { kind: 'proposal', proposalId, ...(chainId === undefined ? {} : { chainId }) } };
      }
      case 'vote': {
        const proposalId = text(ref.proposalId, 80);
        if (!proposalId) return { error: 'vote ref requires proposalId', status: 400 };
        const proposal = await ctx.store.getProposal(proposalId);
        if (!proposal) return { error: 'no such proposal', status: 404 };
        if (!(await ctx.store.getMembership(proposal.circleId, subject))) {
          return { error: 'join the circle to settle your vote on-chain', status: 403 };
        }
        return { settlement: { kind: 'vote', proposalId, subject } };
      }
      case 'invite': {
        // ⚠️ **Founder-gated, like the routes that stock the pool.** `setInvite` is moderator-gated
        // in the circuit too, so a stranger cannot produce a valid proof — but this settlement
        // *writes* a row that decides whether a code is dispensable, and letting any member flip
        // that would let them mark someone else's pending invite as landed.
        const circleId = text(ref.circleId, 80);
        if (!circleId) return { error: 'invite ref requires circleId', status: 400 };
        const circle = await ctx.store.getCircle(circleId);
        if (!circle) return { error: 'no such circle', status: 404 };
        const commitment = text((ref as { commitment?: unknown }).commitment, 64);
        if (commitment === undefined || !/^[0-9a-f]{64}$/.test(commitment)) {
          return { error: 'invite ref requires a 64-lowercase-hex commitment', status: 400 };
        }
        const membership = await ctx.store.getMembership(circleId, subject);
        if (!membership || !holdsFounderAuthority(circle, membership, subject)) {
          return { error: 'only the circle’s founder can settle its invites', status: 403 };
        }
        return { settlement: { kind: 'invite', circleId, commitment } };
      }
      case 'invite-authority': {
        // ⚠️ **Founder-gated even though it settles nothing.** `setInviteAuthority` is
        // moderator-gated in the circuit, so a stranger cannot produce a valid proof — but this
        // route decides whether the *sponsor pays*, and letting any member spend a circle's
        // sponsorship on a delegation they cannot make is a funded refusal for everyone else.
        const circleId = text(ref.circleId, 80);
        if (!circleId) return { error: 'invite-authority ref requires circleId', status: 400 };
        const circle = await ctx.store.getCircle(circleId);
        if (!circle) return { error: 'no such circle', status: 404 };
        const membership = await ctx.store.getMembership(circleId, subject);
        if (!membership || !holdsFounderAuthority(circle, membership, subject)) {
          return { error: 'only the circle’s founder can delegate its invites', status: 403 };
        }
        return { settlement: { kind: 'invite-authority', circleId } };
      }
      case 'transfer': {
        // The caller's own value transfer. There is no content-plane entity to authorize against —
        // and none to check: the transaction moves the caller's funds, not a circle's state. What
        // stands in for that guard is the session (`subject` comes from the token, never the body)
        // plus the rate limit the caller of this function applies, because a transfer's bytes carry
        // nothing identifying them as ours the way a contract call does.
        return { settlement: { kind: 'transfer', subject } };
      }
      default:
        return {
          error:
            "ref.kind must be 'circle', 'membership', 'proposal', 'vote', 'invite', 'invite-authority', or 'transfer'",
          status: 400,
        };
    }
  };

  /**
   * `hooks.keepAlive` is the request's own lifetime, passed in per call rather than captured when the
   * handler was built: the handler is cached per isolate and serves concurrent requests, so a
   * module-level slot would hand one request's work to another request's lifetime.
   */
  return async (request: Request, hooks?: {readonly keepAlive?: (promise: Promise<unknown>) => void}): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    /**
     * Side effects that must outlive the response.
     *
     * ⚠️ **A bare `void promise` does not survive a Worker returning.** Notifications were fired that
     * way — `void ctx.notify.postCreated(...).catch(() => {})` — so the fan-out could be cancelled
     * mid-flight, and the empty catch meant a failure and a cancellation looked identical to a
     * success. `keepAlive` is the request's `ctx.waitUntil`; without it (the Node dev server) a
     * floating promise is fine, because nothing cancels it there.
     */
    const wake = (work: Promise<unknown>): void => {
      const logged = work.catch((error: unknown) => {
        console.log(`[notify] wake failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      hooks?.keepAlive?.(logged);
    };
    if (request.method === 'OPTIONS') {
      return preflight();
    }
    if (request.method === 'GET' && pathname === '/health') {
      return json({ status: 'ok' });
    }
    // Unauthenticated on purpose: it aggregates states and reasons, never a balance or a secret — the
    // sponsor's own numbers stay behind its token, on the other side of this call.
    if (request.method === 'GET' && pathname === '/status') {
      const report = await collectStatus(
        {
          sponsor: sponsorProbe(ctx.sponsorLink),
          store: storeProbe(ctx.store),
          chain: chainProbe(ctx.chain),
        },
        () => new Date(),
      );
      if (prefersHtml(request.headers.get('accept'))) {
        return new Response(renderStatusHtml(report), {
          // Never cached: a stale status page is worse than none.
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders },
        });
      }
      return json(report, report.status === 'failing' ? 503 : 200);
    }
    if (request.method === 'GET' && pathname === '/auth/config') {
      return json({
        devAuth: ctx.devAuth,
        // domain is part of the SIWM contract: native clients can't infer it from an
        // origin the way the web app does, so they build the message from this value.
        domain: ctx.auth.domain,
        network: ctx.auth.network,
        // The identity contract only. A circle's address is derived from its own arguments and rides
        // on the circle record, so there is nothing per-circle to publish here
        // (`docs/CONTRACT_MIGRATION.md`).
        chain: { enabled: ctx.chain.enabled, identityCodeDigest: ctx.chain.identityCodeDigest },
      });
    }
    if (request.method === 'GET' && pathname === '/auth/nonce') {
      return json({ nonce: await ctx.auth.nonces.issue() });
    }
    if (request.method === 'GET' && pathname === '/.well-known/jwks.json') {
      return json({ keys: [ctx.publicJwk] });
    }
    // Login by proving control of an identity row (docs/PNYX_IDENTITY_PLAN.md).
    if (request.method === 'POST' && pathname === '/auth/identity') {
      // `rowReads`, not `enabled`: login only reads a row, and a deployment can do that (via an
      // indexer) while having no write mirror at all.
      if (!ctx.chain.rowReads) {
        return json({ error: 'identity row reads are unavailable' }, 503);
      }
      let body: IdentityLoginRequest;
      try {
        body = (await request.json()) as IdentityLoginRequest;
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }
      if (typeof body?.identity !== 'string' || typeof body?.nonce !== 'string' || typeof body?.signature !== 'string') {
        return json({ error: 'identity, nonce and signature are required strings' }, 400);
      }
      const result = await identityLogin(ctx.auth, body, (id, contract) => ctx.chain.identityRow(id, contract));
      return result.ok ? json({ token: result.token, identity: result.identity }) : json({ error: result.reason }, 401);
    }
    // A ticket for the realtime socket.
    //
    // WebSocket upgrades cannot carry an Authorization header from a browser or React Native, so the
    // credential has to ride in the URL — where it may be logged by anything in the path. A session
    // JWT lives an hour and opens every write route, so this issues a **60-second** token with a
    // different audience instead: `subjectOf` checks `audience: 'pnyx'`, so a leaked ticket cannot be
    // replayed as a session. Not single-use — that would need a store, and the 60 s window plus the
    // audience split is the proportionate trade.
    if (request.method === 'POST' && pathname === '/realtime/ticket') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const ticket = await new SignJWT({ network: ctx.auth.network })
        .setProtectedHeader({ alg: 'ES256', ...(ctx.auth.jwt.kid ? { kid: ctx.auth.jwt.kid } : {}) })
        .setSubject(subject)
        .setIssuer(ctx.auth.jwt.issuer)
        .setAudience(REALTIME_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
        .sign(ctx.auth.jwt.privateKey);
      return json({ ticket, expiresInSeconds: 60 });
    }

    // ── MCP agent pairing ──
    //
    // Outbound only: the phone issues a credential the *agent* consumes, so nothing arrives here to be
    // acted on and the deny-by-default deep-link table is untouched (docs/MCP_DEV_TOOL_SPEC.md §4.5).
    //
    // ⚠️ The token is returned **once**, in the create response. It is not stored and cannot be read
    // back — a "show me the token again" route would put a live credential behind a session that may be
    // months old, and the pairing list is what a user needs afterwards, not the secret.
    if (pathname === '/mcp/pairings') {
      if (ctx.mcpPairings === undefined) {
        return json({ error: 'agent pairing is not configured for this deployment' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) return json({ error: 'authentication required' }, 401);

      if (request.method === 'GET') {
        return json({ pairings: await ctx.mcpPairings.list(subject) });
      }
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => undefined)) as { label?: unknown } | undefined;
        const label = text(body?.label, 80);
        // Named rather than defaulted: the label is the only way a user tells two agents apart when
        // deciding which to revoke, and "Agent 1" tells them nothing.
        if (label === undefined || label.trim() === '') {
          return json({ error: 'label is required — it is how you recognise this agent later' }, 400);
        }
        const { pairing, token } = await ctx.mcpPairings.create({ subject, label: label.trim() });
        return json({ pairing, token }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (request.method === 'POST' && pathname.startsWith('/mcp/pairings/') && pathname.endsWith('/revoke')) {
      if (ctx.mcpPairings === undefined) {
        return json({ error: 'agent pairing is not configured for this deployment' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) return json({ error: 'authentication required' }, 401);
      const pairingId = pathname.slice('/mcp/pairings/'.length, -'/revoke'.length);
      // `revoke` scopes by subject in SQL, so a pairing belonging to someone else reports the same
      // "nothing to revoke" as one that never existed — it does not confirm that an id is real.
      const revoked = await ctx.mcpPairings.revoke({ subject, pairingId });
      return revoked ? json({ revoked: true }) : json({ error: 'no live pairing with that id' }, 404);
    }

    // Clearing dead rows. ⚠️ DELETE rather than another POST verb, and revoked-only in the service: a
    // list of revoked pairings is clutter, but a live one is a working agent, and "clear history" must
    // not be able to cut one off by accident.
    if (request.method === 'DELETE' && pathname.startsWith('/mcp/pairings/')) {
      if (ctx.mcpPairings === undefined) {
        return json({ error: 'agent pairing is not configured for this deployment' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) return json({ error: 'authentication required' }, 401);
      const pairingId = pathname.slice('/mcp/pairings/'.length);
      const forgotten = await ctx.mcpPairings.forget({ subject, pairingId });
      // The same answer for a live row, another subject's, and one that never existed — it does not
      // confirm that an id is real, exactly as revoke does not.
      return forgotten ? json({ forgotten: true }) : json({ error: 'no revoked pairing with that id' }, 404);
    }

    if (request.method === 'POST' && pathname === '/auth/dev') {
      if (!ctx.devAuth) {
        return json({ error: 'dev auth is disabled' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      const name = text(body.name, 60);
      if (!name) {
        return json({ error: 'name is required' }, 400);
      }
      const subject = `dev:${name}`;
      return json({ token: await issueJwt(subject), address: subject });
    }

    // Bind this device's push token to an identity.
    //
    // Two credentials, on purpose. The JWT keeps this from being an open endpoint that anyone can
    // make do an indexer read, and pins the row we write to the authenticated subject. The
    // *signature* is what proves ownership: a JWT is a bearer token, so on its own it would let
    // whoever holds one redirect the victim's notifications to their own device — leaking who
    // messages them and which circles are active. The identity key never leaves the device.
    if (request.method === 'POST' && pathname === '/devices') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        fcmToken?: unknown;
        platform?: unknown;
        nonce?: unknown;
        signature?: unknown;
        contract?: unknown;
      };
      const fcmToken = text(body.fcmToken, 4096);
      const platform = text(body.platform, 20);
      if (!fcmToken || !platform) {
        return json({ error: 'fcmToken and platform are required strings' }, 400);
      }

      // A `/auth/dev` session has no identity key — its subject is `dev:<name>`, not an `pnyx_id`,
      // so there is nothing it could sign with. Exempted so local push testing keeps working, and
      // reachable only while `devAuth` is on, exactly like the route that mints those tokens. With
      // DEV_AUTH=0 (mandatory on any public origin) a binding is always signature-checked.
      const isDevSubject = ctx.devAuth && subject.startsWith('dev:');
      if (!isDevSubject) {
        if (!ctx.chain.rowReads) {
          return json({ error: 'identity row reads are unavailable' }, 503);
        }
        const nonce = text(body.nonce, 120);
        const signature = text(body.signature, 200);
        const contract = text(body.contract, 64);
        if (!nonce || !signature) {
          return json({ error: 'nonce and signature are required strings (GET /auth/nonce first)' }, 400);
        }
        // Verified against the subject from the JWT, never an identity from the body: that is what
        // stops a valid binding for identity A being submitted under B's session.
        const verified = await verifyDeviceBinding(
          ctx.auth,
          // The contract comes from the body like the signature does, and is checked the same way the
          // login checks it — the row it names has to be in a contract of our template sealed to this
          // subject. Without it a device binding could not be verified at all: there is no address to
          // fall back to.
          { identity: subject, nonce, fcmToken, platform, signature, ...(contract === undefined ? {} : { contract }) },
          (id, named) => ctx.chain.identityRow(id, named),
        );
        if (!verified.ok) {
          return json({ error: `device binding rejected: ${verified.reason}` }, 401);
        }
      }
      await ctx.store.registerDevice(subject, { fcmToken, platform });
      return json({ registered: true }, 201);
    }

    // ── Direct messages (docs/DIRECT_MESSAGES_PLAN.md phase 4) ──
    //
    // `idList` is shared by every route that names rows to remove. Returns the ids, or a string
    // explaining the refusal — one shape of validation rather than four copies that drift.
    
    //
    // Delivery only. Every payload here is opaque MLS bytes: the service cannot read a message,
    // cannot forge one (MLS authenticates the sender, not this JWT), and holds no key material.
    // The JWT subject is the caller's `pnyx_id` (auth.ts sets it to the identity it authenticated),
    // so the `sender` column is bound to the authenticated caller rather than taken from the body —
    // a client cannot post as somebody else even though MLS is what actually proves authorship.
    //
    // Identity anchors are NOT here; they are on chain in `identities`, which clients read from an
    // indexer themselves — this service never sees a row lookup.
    // Anything that would make this service authoritative — minting ids, assigning order — is
    // deliberately absent so the port stays swappable.

    // Publish my KeyPackage pool. Idempotent: the id is a content hash, so a client that re-uploads
    // after a failed request cannot duplicate rows or resurrect a spent package.
    if (request.method === 'POST' && pathname === '/dm/key-packages') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { packages?: unknown };
      if (!Array.isArray(body.packages) || body.packages.length === 0) {
        return json({ error: 'packages must be a non-empty array of base64 strings' }, 400);
      }
      if (body.packages.length > 100) {
        return json({ error: 'at most 100 packages per request' }, 400);
      }
      const decoded: { id: string; keyPackage: Uint8Array }[] = [];
      for (const entry of body.packages) {
        const bytes = fromBase64(entry);
        if (!bytes || bytes.length === 0 || bytes.length > 16384) {
          return json({ error: 'each package must be base64 of 1–16384 bytes' }, 400);
        }
        decoded.push({ id: await sha256Hex(bytes), keyPackage: bytes });
      }
      const added = await ctx.store.publishDmKeyPackages(subject, decoded);
      return json({ added, available: await ctx.store.countDmKeyPackages(subject) }, 201);
    }

    // My remaining pool depth — the client refills when this runs low. Only ever about the caller:
    // another subject's depth is not disclosed, since it would leak how many conversations they
    // have been invited into.
    if (request.method === 'GET' && pathname === '/dm/key-packages') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      return json({ available: await ctx.store.countDmKeyPackages(subject) });
    }

    // Withdraw packages whose private half this device no longer holds.
    //
    // Without it, a package outlives its usable life on the server: a peer claims one, seals a
    // Welcome to it, and their invite dies at "no matching key package" — silently, on their side,
    // with nothing to retry. The client calls this with exactly the ids it just pruned locally.
    //
    // POST rather than DELETE because the ids travel in a body, and a request body on DELETE is
    // legal but unevenly carried by intermediaries; a dropped body here would silently retire
    // nothing, which is the failure mode this whole route exists to remove.
    if (request.method === 'POST' && pathname === '/dm/key-packages/retire') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
      // ⚠️ `all` is for a device that lost its private halves wholesale and cannot name the ids,
      // because they went with them. Without it a reset device's pool stays full of packages nobody
      // can open, and every peer who claims one gets an invite that dies on arrival.
      if (body.all === true) {
        const retired = await ctx.store.retireAllDmKeyPackages(subject);
        return json({ retired, available: await ctx.store.countDmKeyPackages(subject) });
      }
      const ids = idList(body);
      if (typeof ids === 'string') {
        return json({ error: ids }, 400);
      }
      const retired = await ctx.store.retireDmKeyPackages(subject, ids);
      return json({ retired, available: await ctx.store.countDmKeyPackages(subject) });
    }

    // Claim one of a peer's packages in order to add them to a group. 409 rather than 404 when the
    // pool is empty: the peer exists, they just cannot be added until they refill — a distinction
    // the UI needs to word the failure honestly.
    // The peer segment is matched permissively rather than against the bech32 `mn_addr` shape:
    // subjects are opaque to this service (dev auth issues `dev:<name>`), and an address that does
    // not exist already yields 409, so shape validation would add a failure mode without safety.
    const claimAddress = /^\/dm\/key-packages\/([^/]+)\/claim$/.exec(pathname)?.[1];
    if (request.method === 'POST' && claimAddress !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const target = decodeURIComponent(claimAddress);
      // ⚠️ **A bound on draining, not consent** — see `dm-claim-limit.ts`. A claim used to be
      // anonymous and unlimited, so one stranger could take every package a subject had published
      // and leave them unreachable until their device refilled.
      const recent = await ctx.store.countRecentDmClaims(target, subject, claimWindowStart(Date.now()));
      if (!mayClaim(recent)) {
        console.log(`[dm] claim cap reached: ${recent} claims against one pool inside the window`);
        return json({ error: 'too many key packages claimed from that identity recently' }, 429);
      }
      // Refused *before* the claim, so a package is not burned on a conversation that cannot happen.
      const consent = await resolveConsent(target, subject, presentedPermit(request));
      if (!consent.ok) return consentRefusal(consent.reason);
      const claimed = await ctx.store.claimDmKeyPackage(target, subject);
      if (!claimed) {
        return json({ error: 'no key packages available for that identity' }, 409);
      }
      return json({ keyPackage: toBase64(claimed.keyPackage) });
    }

    // Confirm Welcomes that are durably joined, so they stop being redelivered. Scoped to the
    // authenticated recipient: nobody can retire an invite addressed to somebody else.
    if (request.method === 'POST' && pathname === '/dm/welcomes/ack') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const ids = idList(await request.json().catch(() => ({})));
      if (typeof ids === 'string') {
        return json({ error: ids }, 400);
      }
      return json({ acked: await ctx.store.ackDmWelcomes(subject, ids) });
    }

    // Confirm delivered messages, which is what lets the ciphertext be dropped.
    //
    // ⚠️ **Scoped to the recipient, and that is the whole safety of it.** One row serves both
    // parties, so a sender acking its own outgoing message would delete it before the other side had
    // ever fetched it. The sender needs no copy: its plaintext was stored at send, and MLS gives a
    // sender no way to reopen its own message in any case.
    if (request.method === 'POST' && pathname === '/dm/messages/ack') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const ids = idList(await request.json().catch(() => ({})));
      if (typeof ids === 'string') {
        return json({ error: ids }, 400);
      }
      return json({ acked: await ctx.store.ackDmMessages(subject, ids) });
    }

    // ── Consent: who may reach me, and whether it buzzes (docs/ABUSE_MITIGATION.md §5) ──

    // My policy. Absent means `open`, which is what every identity was before this existed.
    if (request.method === 'GET' && pathname === '/dm/policy') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      return json({ policy: (await ctx.store.readDmPolicy(subject)) ?? DEFAULT_DM_POLICY });
    }

    // ⚠️ Only ever about the caller. A policy is a preference, but *another* identity's policy is a
    // fact about how reachable they are, and publishing it would hand a spammer a target list.
    if (request.method === 'PUT' && pathname === '/dm/policy') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { policy?: unknown };
      if (!isDmPolicy(body.policy)) {
        return json({ error: 'policy must be one of open, permit, closed' }, 400);
      }
      await ctx.store.writeDmPolicy(subject, body.policy, new Date().toISOString());
      return json({ policy: body.policy });
    }

    // Grant one identity the right to reach me. Targeted: the token names its bearer, and delivery
    // checks that name against the authenticated sender, so a leaked permit is worthless.
    if (request.method === 'POST' && pathname === '/dm/permits') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        bearer?: unknown;
        notify?: unknown;
        ttlSeconds?: unknown;
      };
      // ⚠️ Absent `bearer` is an **invite** — a link or QR anyone may convert — not an omission.
      // Required-and-missing would rule out the only shape that works when the issuer cannot know
      // in advance who will take it up, which is what sharing one in a circle means.
      const bearer = body.bearer === undefined ? undefined : text(body.bearer, 120);
      if (body.bearer !== undefined && bearer === undefined) {
        return json({ error: 'bearer must be an identity, or omitted for an invite anyone can use' }, 400);
      }
      const ttl = typeof body.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds) ? body.ttlSeconds : undefined;
      if (ttl !== undefined && (ttl <= 0 || ttl > PERMIT_MAX_TTL_SECONDS)) {
        return json({ error: `ttlSeconds must be between 1 and ${PERMIT_MAX_TTL_SECONDS}` }, 400);
      }
      const { token, permit } = await issuePermit(
        {
          privateKey: ctx.auth.jwt.privateKey,
          issuer: ctx.auth.jwt.issuer,
          ...(ctx.auth.jwt.kid ? { kid: ctx.auth.jwt.kid } : {}),
        },
        {
          issuer: subject,
          ...(bearer === undefined ? {} : { bearer }),
          ...(body.notify === false ? { notify: false } : {}),
          ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
        },
      );
      return json(
        { permit: token, jti: permit.jti, expiresAt: permit.expiresAt, invite: bearer === undefined },
        201,
      );
    }

    // Mute: silence a permit without un-accepting the conversation.
    //
    // ⚠️ **Authorised by knowing the id**, which is a capability rather than an ownership check —
    // this service stores no mapping from a permit to the pair it covers, which is the whole reason
    // muting leaves no graph behind. The id is 128 bits of randomness and only ever travels to the
    // two parties, and the worst a holder can do is silence pushes for that one conversation:
    // delivery, reading and sending are all unaffected.
    if (request.method === 'POST' && pathname === '/dm/permits/revoke') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { jti?: unknown; expiresAt?: unknown };
      const jti = text(body.jti, 64);
      if (!jti) {
        return json({ error: 'jti is required' }, 400);
      }
      const expiresAt =
        typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
          ? new Date(body.expiresAt * 1000).toISOString()
          : new Date(Date.now() + PERMIT_MAX_TTL_SECONDS * 1000).toISOString();
      await ctx.store.revokeDmPermit(jti, new Date().toISOString(), expiresAt);
      return json({ revoked: true });
    }

    // Unmute outright, rather than waiting for a fresh permit to out-date the cutoff.
    if (request.method === 'POST' && pathname === '/dm/permits/unrevoke') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const jti = text(((await request.json().catch(() => ({}))) as { jti?: unknown }).jti, 64);
      if (!jti) {
        return json({ error: 'jti is required' }, 400);
      }
      await ctx.store.clearDmPermitRevocation(jti);
      return json({ revoked: false });
    }

    // Blocks. The one pair this layer stores, and the one a user would be upset to see expire.
    if (request.method === 'GET' && pathname === '/dm/blocks') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      return json({ blocks: await ctx.store.listDmBlocks(subject) });
    }

    if (request.method === 'POST' && pathname === '/dm/blocks') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const peer = text(((await request.json().catch(() => ({}))) as { peer?: unknown }).peer, 120);
      if (!peer) {
        return json({ error: 'peer is required' }, 400);
      }
      // ⚠️ Blocking yourself would make the notes-to-self path unreachable and is never intended.
      if (peer === subject) {
        return json({ error: 'you cannot block yourself' }, 400);
      }
      await ctx.store.blockDmPeer(subject, peer, new Date().toISOString());
      return json({ blocked: true }, 201);
    }

    const unblockPeer = /^\/dm\/blocks\/([^/]+)$/.exec(pathname)?.[1];
    if (request.method === 'DELETE' && unblockPeer !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      await ctx.store.unblockDmPeer(subject, decodeURIComponent(unblockPeer));
      return json({ blocked: false });
    }

    // My inbox: conversations I am party to, most recent first. Metadata only — no ciphertext.
    if (request.method === 'GET' && pathname === '/dm') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      return json({ conversations: await ctx.store.listDmConversations(subject) });
    }

    // My pending Welcomes. ⚠️ **No longer destructive** (2026-09-01). This used to delete on read,
    // which made delivery at-most-once on a payload that cannot be regenerated: a Welcome is
    // single-use, so anything between the delete and the client durably saving group state lost the
    // invite for ever — a dropped response, an app killed mid-drain, a join that threw, a private
    // half that had gone missing. Each one presented as a conversation that could never be opened.
    // The recipient now confirms with `/dm/welcomes/ack`; until then it is redelivered, and the
    // client skips a join it has already done rather than resetting a live ratchet.
    if (request.method === 'GET' && pathname === '/dm/welcomes') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const welcomes = await ctx.store.listDmWelcomes(subject);
      return json({
        welcomes: welcomes.map((w) => ({
          id: w.id,
          convId: w.convId,
          sender: w.sender,
          welcome: toBase64(w.welcome),
          ratchetTree: toBase64(w.ratchetTree),
          createdAt: w.createdAt,
          // The invite's permit id, for the same reason as a message's — see the messages route.
          ...(w.permitJti === undefined ? {} : { permitJti: w.permitJti }),
        })),
      });
    }

    const welcomeConvId = /^\/dm\/([0-9a-f]{64})\/welcome$/.exec(pathname)?.[1];
    if (request.method === 'POST' && welcomeConvId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown;
        recipient?: unknown;
        welcome?: unknown;
        ratchetTree?: unknown;
      };
      const id = text(body.id, 80);
      const recipient = text(body.recipient, 120);
      const welcome = fromBase64(body.welcome);
      const ratchetTree = fromBase64(body.ratchetTree);
      if (!id || !recipient || !welcome || !ratchetTree) {
        return json({ error: 'id, recipient, welcome and ratchetTree are required' }, 400);
      }
      if (!isConversationBetween(welcomeConvId, subject, recipient)) {
        return json({ error: 'that conversation is not between you and that recipient' }, 403);
      }
      const consent = await resolveConsent(recipient, subject, presentedPermit(request));
      if (!consent.ok) return consentRefusal(consent.reason);
      await ctx.store.putDmWelcome({
        id,
        convId: welcomeConvId,
        sender: subject,
        recipient,
        welcome,
        ratchetTree,
        ...(consent.jti === undefined ? {} : { permitJti: consent.jti }),
      });
      // A muted invite still arrives, silently. See `dm-consent.ts` — muting is not un-accepting.
      if (consent.notify) wake(ctx.notify.dmArrived(recipient, 'dm-invite'));
      return json({ delivered: true, ...(consent.issued === undefined ? {} : { permit: consent.issued }) }, 201);
    }

    // Poll a conversation. `since` is an exclusive createdAt cursor, so a client that stores the
    // last value it saw never re-processes a message (MLS would reject the replay anyway, but
    // re-processing would advance nothing and look like a decrypt failure).
    const messagesConvId = /^\/dm\/([0-9a-f]{64})\/messages$/.exec(pathname)?.[1];
    if (request.method === 'GET' && messagesConvId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const since = text(url.searchParams.get('since'), 40);
      const messages = await ctx.store.listDmMessages(messagesConvId, subject, since);
      return json({
        messages: messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          ciphertext: toBase64(m.ciphertext),
          createdAt: m.createdAt,
          // ⚠️ How the *recipient* learns a permit's id: the sender presents the permit on every
          // delivery, so it rides the row rather than being stored against the pair. Muting names
          // this id, which is why nothing here has to remember who may talk to whom.
          ...(m.permitJti === undefined ? {} : { permitJti: m.permitJti }),
        })),
      });
    }

    if (request.method === 'POST' && messagesConvId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown;
        recipient?: unknown;
        ciphertext?: unknown;
      };
      const id = text(body.id, 80);
      const recipient = text(body.recipient, 120);
      const ciphertext = fromBase64(body.ciphertext);
      if (!id || !recipient || !ciphertext) {
        return json({ error: 'id, recipient and ciphertext are required' }, 400);
      }
      if (!isConversationBetween(messagesConvId, subject, recipient)) {
        return json({ error: 'that conversation is not between you and that recipient' }, 403);
      }
      const consent = await resolveConsent(recipient, subject, presentedPermit(request));
      if (!consent.ok) return consentRefusal(consent.reason);
      const message = await ctx.store.appendDmMessage({
        id,
        convId: messagesConvId,
        sender: subject,
        recipient,
        ciphertext,
        ...(consent.jti === undefined ? {} : { permitJti: consent.jti }),
      });
      // No conversation id in the signal *or* the push: the recipient fetches its own conversations,
      // and naming one here would put "who is talking to whom" into the realtime plane — and, for the
      // push, into FCM. Both transports come from `dmArrived`, so they cannot disagree about who cares.
      if (consent.notify) wake(ctx.notify.dmArrived(recipient, 'dm-message'));
      return json(
        {
          id: message.id,
          createdAt: message.createdAt,
          ...(consent.issued === undefined ? {} : { permit: consent.issued }),
        },
        201,
      );
    }

    // Circuit artifacts for on-device proving: public data (the app verifies the SHA-256s and caches
    // the files), one target per contract. Served whenever the artifacts are configured — they are
    // keyed by the compiled code, not by a deployment, so a circle's keys are available before its
    // contract exists.
    //
    // **The paths mirror the R2 bucket exactly**, so `EXPO_PUBLIC_ARTIFACTS_URL` can point at either
    // without the app knowing which it got. They used to be a REST shape
    // (`/chain/artifacts/<target>/<circuit>/<kind>`) while the app fetched
    // `<origin>/<target>/<circuit>.<kind>` — two layouts that could never line up, even though
    // `pnyx-artifacts/origin.ts` documented pointing a local build at this service. One layout now.
    const manifestTarget = /^\/chain\/artifacts\/([a-z]+)\/manifest\.json$/.exec(pathname)?.[1];
    if (request.method === 'GET' && manifestTarget !== undefined) {
      const service = ctx.artifacts?.[manifestTarget];
      if (!service) {
        return json({ error: `chain artifacts are not available for target "${manifestTarget}"` }, 503);
      }
      return json(service.manifest());
    }
    const [, artifactTarget, artifactCircuit, artifactKind] =
      /^\/chain\/artifacts\/([a-z]+)\/([A-Za-z0-9_-]+)\.([a-z]+)$/.exec(pathname) ?? [];
    if (
      request.method === 'GET' &&
      artifactTarget !== undefined &&
      artifactCircuit !== undefined &&
      artifactKind !== undefined
    ) {
      const service = ctx.artifacts?.[artifactTarget];
      if (!service) {
        return json({ error: `chain artifacts are not available for target "${artifactTarget}"` }, 503);
      }
      const filePath = service.filePath(artifactCircuit, artifactKind);
      if (!filePath) {
        return json({ error: 'no such artifact' }, 404);
      }
      return binary(await readFile(filePath), `${artifactCircuit}.${artifactKind}`);
    }
    // `params/bls_midnight_2p<K>`, the bucket's own name for the SRS.
    const paramsK = /^\/chain\/artifacts\/params\/bls_midnight_2p(\d+)$/.exec(pathname)?.[1];
    if (request.method === 'GET' && paramsK !== undefined) {
      // The SRS is contract-independent, so any configured target can serve it.
      const anyService = Object.values(ctx.artifacts ?? {})[0];
      if (!anyService) {
        return json({ error: 'chain artifacts are not available' }, 503);
      }
      const filePath = anyService.paramsPath(paramsK);
      if (!filePath) {
        return json({ error: 'no such params (K)' }, 404);
      }
      return binary(await readFile(filePath), `bls_midnight_2p${paramsK}`);
    }

    // Current on-chain contract state (serialized, hex) — the public data the device's native
    // preimage builders execute a circuit against. Proxied through the service for now (the app can
    // move to querying the indexer directly later, for better unlinkability).
    if (request.method === 'GET' && pathname === '/chain/state') {
      if (!ctx.chain.enabled) {
        return json({ error: 'chain mirroring is disabled' }, 503);
      }
      try {
        return json({ state: toHex(await ctx.chain.contractState()) });
      } catch (e) {
        return json({ error: `contract state unavailable: ${e instanceof Error ? e.message : String(e)}` }, 502);
      }
    }

    // Phase-B device-proving rail: the device ships a proven-but-unbound transaction; the service
    // balances its DUST fee from the sponsor wallet and submits it, then settles the referenced
    // ChainRef (pending → confirmed/failed) asynchronously — the interim action endpoints keep
    // working during the cutover.
    if (request.method === 'POST' && pathname === '/chain/submit') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      if (!ctx.chain.enabled) {
        return json({ error: 'chain mirroring is disabled' }, 503);
      }
      const body = (await request.json().catch(() => ({}))) as { tx?: unknown; ref?: unknown; network?: unknown };
      // A proven pnyx call tx is a few KB; base64 inflates ~4/3, so cap generously.
      const txB64 = text(body.tx, 4_000_000);
      if (!txB64) {
        return json({ error: 'tx is required (base64-encoded serialized proven transaction)' }, 400);
      }
      // Buffer base64 decoding is lenient (never throws — invalid chars are dropped); a malformed
      // payload that survives to non-empty bytes is rejected downstream at deserialize (the
      // settlement's ChainRef flips to 'failed'), so only the empty result is a 400 here.
      const bytes = Uint8Array.from(Buffer.from(txB64, 'base64'));
      if (bytes.length === 0) {
        return json({ error: 'tx decoded to empty bytes' }, 400);
      }
      const resolved = await resolveSettlement(body.ref, subject);
      if ('error' in resolved) {
        return json({ error: resolved.error }, resolved.status);
      }
      // A transfer is the one settlement with no content-plane guard behind it — every other kind
      // had to belong to a circle the caller is in, which bounds it. Here the session is the only
      // bound, so the rate limit is not belt-and-braces: it *is* the limit on how much DUST one
      // authenticated caller can spend. Keyed on the subject rather than the request, because the
      // subject is what the guard is about (`docs/ABUSE_MITIGATION.md`).
      if (resolved.settlement.kind === 'transfer') {
        if (!(await (ctx.transferLimit ?? noRateLimit).allow(`transfer:${subject}`))) {
          return json({ error: 'too many sponsored transfers — try again shortly' }, 429);
        }
      }
      // `cf-ray` is the id Cloudflare already stamps on this request and logs against it, so passing it
      // inward makes the sponsor's line joinable to the Worker's instead of matchable only by clock.
      // ⚠️ **Which Midnight network these bytes are for.** The sponsor host holds one wallet per network
      // and a transaction handed to the wrong one is accepted and then refused deep inside `balanceTx`
      // (seen 2026-08-28: `invalid network ID - expect 'preview' found 'preprod'`, minutes after a 202).
      // A routing hint, not a claim the service believes — the sponsor checks the bytes itself. Absent
      // means "the host's default", which is what every caller written before this meant.
      const network = readNetwork(body.network);
      if ('error' in network) {
        return json({ error: network.error }, 400);
      }
      const submitContext = {
        ...(request.headers.get('cf-ray') === null ? {} : { requestId: request.headers.get('cf-ray') as string }),
        ...(hooks?.keepAlive === undefined ? {} : { keepAlive: hooks.keepAlive }),
        ...(network.network === undefined ? {} : { network: network.network }),
      };
      /**
       * ⚠️ **A transfer waits for the sponsor to accept it; every other kind does not.**
       *
       * The difference is that a transfer has **no content-plane row**. Every other settlement writes a
       * ChainRef, so a refusal lands as `failed` on something the app already reads — but a transfer's
       * only record is the device's own pending-send row, and that row is written *because* this route
       * answered 202. Refuse after the 202 and the app shows "Pending" for a transaction that was turned
       * away before it left the building, for the two hours until its own TTL abandons it. Observed on a
       * device, 2026-08-28, twice.
       *
       * One extra round trip to the sponsor host, which answers as soon as it has queued the bytes — it
       * does not wait for the chain either way, so this buys a real answer for very little.
       */
      if (resolved.settlement.kind === 'transfer') {
        const outcome = await ctx.chain.submitProven(resolved.settlement, bytes, submitContext);
        if (!outcome.accepted) {
          // 502, not 400: the caller's bytes may be perfectly good and the sponsor may simply be the
          // wrong one or unwell. The reason is the sponsor's own, passed through rather than summarised.
          return json({ error: outcome.error }, 502);
        }
        // `txId` when the sponsor got far enough to have one. The device stores it as the handle for
        // "did it land", which it previously had no way to learn — see `sponsor-server.ts`.
        return json({ accepted: true, ...(outcome.txId === undefined ? {} : { txId: outcome.txId }) }, 202);
      }
      void ctx.chain.submitProven(resolved.settlement, bytes, submitContext);
      return json({ accepted: true }, 202);
    }

    // Register or rotate an identity row (docs/PNYX_IDENTITY_PLAN.md).
    //
    // **Deliberately unauthenticated**, because it is what bootstraps authentication: a new
    // identity must publish `authPub` before it can log in with it. That is safe here in a way it
    // never was for the old anchor route — the body is a *proven* transaction the service cannot author
    // (the circuit needs the identity secret), so this endpoint only relays. The chain decides
    // what is valid; the worst an attacker gets is to spend our DUST on transactions that write
    // rows they already control, which is ordinary rate-limiting territory rather than a forgery.
    if (request.method === 'POST' && pathname === '/register') {
      if (!ctx.chain.enabled) {
        return json({ error: 'chain mirroring is disabled' }, 503);
      }
      // Before reading the body: an over-limit caller should cost us the header check, not a 4 MB
      // parse. Nobody can forge a row here (the transaction is proven and we cannot author it), but
      // anyone can make the sponsor pay to submit one, so the limit is on spend, not on forgery.
      if (!(await (ctx.registerLimit ?? noRateLimit).allow(rateLimitKey(request)))) {
        return json({ error: 'too many registration attempts; retry in a minute' }, 429);
      }
      const body = (await request.json().catch(() => ({}))) as { tx?: unknown };
      const txB64 = text(body.tx, 4_000_000);
      if (!txB64) {
        return json({ error: 'tx is required (base64-encoded proven publishIdentityRow transaction)' }, 400);
      }
      const bytes = Uint8Array.from(Buffer.from(txB64, 'base64'));
      if (bytes.length === 0) {
        return json({ error: 'tx decoded to empty bytes' }, 400);
      }
      try {
        await ctx.chain.submitIdentityRow(bytes, {
          ...(request.headers.get('cf-ray') === null ? {} : { requestId: request.headers.get('cf-ray') as string }),
        });
        return json({ registered: true }, 202);
      } catch (e) {
        return json({ error: `register failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
      }
    }

    // Settlement reports from the sponsor host (`services/content/src/sponsor-server.ts`).
    //
    // Cloudflare owns the ChainRef rows; the sponsor owns the wallet. It submits, watches, and reports
    // the outcome here — so there is one source of truth for "is this on chain yet" rather than a copy
    // on each host. Authenticated by a shared secret, and the body is validated rather than trusted:
    // it names a row to write.
    // Bug reports. ⚠️ **Not JWT-authenticated, deliberately.** A report is most valuable exactly
    // when the session is broken — a login that fails is a bug worth filing, and requiring a
    // working session would refuse the reports we most need. CIP-8 over the body digest is the
    // auth instead: it proves control of a Cardano address without any server-side state.
    if (request.method === 'POST' && pathname === '/bug-report') {
      if (ctx.bugReports === undefined) {
        return json({ error: 'bug reports are not configured for this deployment' }, 404);
      }
      // Keyed on the signing address, which is the only identity this route has. Before the
      // signature is checked, so a flood of unsigned bodies cannot buy R2 writes — the limiter
      // sees the claimed address, and a claimed one is enough to bucket by.
      const claimed = request.headers.get(BUG_REPORT_HEADERS.address) ?? 'anonymous';
      if (ctx.bugReportLimit !== undefined && !(await ctx.bugReportLimit.allow(`bug-report:${claimed}`))) {
        return json({ error: 'too many reports; try again shortly' }, 429);
      }
      const outcome = await acceptBugReport(request, ctx.bugReports);
      if (outcome.ok) {
        console.log(`[bug-report] accepted ${outcome.id} from ${claimed}`);
        return json({ id: outcome.id }, outcome.status);
      }
      // Logged with the reason: a client that cannot file reports has no other way to tell us
      // why, so this line is the only evidence the rejection ever happened.
      console.log(`[bug-report] refused (${outcome.rejection}) from ${claimed}`);
      return json({ error: outcome.rejection }, outcome.status);
    }

    if (request.method === 'POST' && pathname === '/internal/settle') {
      if (ctx.sponsorToken === undefined || ctx.sponsorToken === '') {
        return json({ error: 'no sponsor is configured for this deployment' }, 404);
      }
      if (request.headers.get('authorization') !== `Bearer ${ctx.sponsorToken}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const parsed = parseSettlementReport(await request.json().catch(() => undefined));
      if ('error' in parsed) {
        return json({ error: parsed.error }, 400);
      }
      await applySettlement(ctx.store, parsed.settlement, parsed.chain);
      await publishSettlement(parsed.settlement);
      return json({ recorded: true });
    }

    // `GET /identities/:C` used to live here. It is gone, not moved: the app reads contract state
    // from an indexer and decodes the row itself, so relaying the lookup only told this service who
    // was looking up whom. `ctx.chain.identityRow` survives for `POST /auth/identity`, which must
    // read `authPub` server-side — the app cannot be trusted to report the key it is authenticating
    // against.

    if (request.method === 'GET' && pathname === '/circles') {
      return json({ circles: (await ctx.store.listCircles()).map(publicCircle) });
    }
    if (request.method === 'POST' && pathname === '/circles') {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        name?: unknown;
        description?: unknown;
        persona?: unknown;
        isOpen?: unknown;
      };
      const name = text(body.name, 120);
      const description = text(body.description, 2000) ?? '';
      const choice = personaChoice(subject, body);
      if (!name) {
        return json({ error: 'name is required (≤120 chars)' }, 400);
      }
      if (!choice) {
        return json({ error: 'persona must be 1–40 chars' }, 400);
      }
      // ⚠️ Rejected rather than coerced, and omitted means open. The value is sealed into the
      // contract's address, so a client that sent `"false"` and got a circle anyone can join would be
      // told it was gated by a row that disagrees with the chain. Omission is the old clients' shape
      // and they only ever made open circles.
      if (body.isOpen !== undefined && typeof body.isOpen !== 'boolean') {
        return json({ error: 'isOpen must be a boolean' }, 400);
      }
      const isOpen = body.isOpen ?? true;
      const circle = await ctx.store.createCircle({ name, description, subject, isOpen, ...choice });
      return json(
        {
          circle: publicCircle((await ctx.store.getCircle(circle.id)) ?? circle),
          membership: await ctx.store.getMembership(circle.id, subject),
        },
        201,
      );
    }

    const circleId = /^\/circles\/([0-9a-f-]+)$/.exec(pathname)?.[1];
    if (request.method === 'GET' && circleId !== undefined) {
      const circle = await ctx.store.getCircle(circleId);
      if (!circle) {
        return json({ error: 'no such circle' }, 404);
      }
      await resolveCircleTemplate(circle);
      const subject = await subjectOf(request);
      const membership = subject ? ((await ctx.store.getMembership(circle.id, subject)) ?? null) : null;
      const proposals = await Promise.all(
        (await ctx.store.listProposals(circle.id)).map(async (proposal) => ({
          ...proposal,
          hasVoted: subject ? await ctx.store.hasVoted(proposal.id, subject) : false,
          myVoteChain: subject ? ((await ctx.store.getVoteChain(proposal.id, subject)) ?? null) : null,
        })),
      );
      return json({
        circle: publicCircle(circle),
        membership,
        proposals,
        posts: await ctx.store.listPosts(circle.id),
        channels: await ctx.store.listChannels(circle.id),
      });
    }

    const joinCircleId = /^\/circles\/([0-9a-f-]+)\/join$/.exec(pathname)?.[1];
    if (request.method === 'POST' && joinCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      if (!(await ctx.store.getCircle(joinCircleId))) {
        return json({ error: 'no such circle' }, 404);
      }
      const body = (await request.json().catch(() => ({}))) as { persona?: unknown };
      const choice = personaChoice(subject, body);
      if (!choice) {
        return json({ error: 'persona must be 1–40 chars' }, 400);
      }
      const result = await ctx.store.join({ circleId: joinCircleId, subject, ...choice });
      if (result === 'already-joined') {
        return json({ error: 'already a member of this circle' }, 409);
      }
      if (result === 'persona-taken') {
        return json({ error: 'that persona name is taken in this circle' }, 409);
      }
      return json({ membership: await ctx.store.getMembership(joinCircleId, subject) }, 201);
    }

    const leaveCircleId = /^\/circles\/([0-9a-f-]+)\/leave$/.exec(pathname)?.[1];
    if (request.method === 'POST' && leaveCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      if (!(await ctx.store.getCircle(leaveCircleId))) {
        return json({ error: 'no such circle' }, 404);
      }
      // ⚠️ **This un-lists; it does not un-member.** Membership is a leaf in the circle's on-chain
      // `members` tree and only `leaveCircle` removes it. The app proves and submits that first, so
      // this row goes last — the reverse order would leave someone off every list while they could
      // still prove they belonged. Nothing here can verify the chain half happened; it is the same
      // trust boundary `join` already sits on, where the content row shadows the tree.
      const result = await ctx.store.leave(leaveCircleId, subject);
      if (result === 'not-a-member') {
        return json({ error: 'not a member of this circle' }, 404);
      }
      return json({ left: true });
    }

    const postsCircleId = /^\/circles\/([0-9a-f-]+)\/posts$/.exec(pathname)?.[1];
    if (request.method === 'POST' && postsCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const membership = await ctx.store.getMembership(postsCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to post' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as {
        body?: unknown;
        parentId?: unknown;
        channelId?: unknown;
      };
      const content = text(body.body, 10_000);
      if (!content) {
        return json({ error: 'body is required (≤10000 chars)' }, 400);
      }
      let parentId: string | undefined;
      if (body.parentId !== undefined) {
        const parent = typeof body.parentId === 'string' ? await ctx.store.getPost(body.parentId) : undefined;
        if (!parent || parent.circleId !== postsCircleId) {
          return json({ error: 'parent post not found in this circle' }, 400);
        }
        parentId = parent.id;
      }
      let channelId: string | undefined;
      if (body.channelId !== undefined && body.channelId !== null) {
        // Verified against this circle's own channels rather than trusted: a channel id from another
        // circle would file the post where none of that circle's members would ever read it.
        const channels = await ctx.store.listChannels(postsCircleId);
        const channel = channels.find((c) => c.id === body.channelId);
        if (!channel) {
          return json({ error: 'channel not found in this circle' }, 400);
        }
        channelId = channel.id;
      }
      const post = await ctx.store.createPost({
        circleId: postsCircleId,
        ...(parentId === undefined ? {} : { parentId }),
        ...(channelId === undefined ? {} : { channelId }),
        body: content,
        author: membership.persona,
      });
      // Notification intents are best-effort and never block the response.
      wake(ctx.notify.postCreated(postsCircleId, post, subject));
      return json({ post }, 201);
    }

    const channelsCircleId = /^\/circles\/([0-9a-f-]+)\/channels$/.exec(pathname)?.[1];
    if (request.method === 'GET' && channelsCircleId !== undefined) {
      if (!(await ctx.store.getCircle(channelsCircleId))) {
        return json({ error: 'no such circle' }, 404);
      }
      // Readable by anyone who can see the circle: a channel name is a label on public content, and
      // hiding the list would not hide the posts it groups.
      return json({ channels: await ctx.store.listChannels(channelsCircleId) });
    }
    if (request.method === 'POST' && channelsCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const circle = await ctx.store.getCircle(channelsCircleId);
      if (!circle) {
        return json({ error: 'no such circle' }, 404);
      }
      const membership = await ctx.store.getMembership(channelsCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to create a channel' }, 403);
      }
      if (!holdsFounderAuthority(circle, membership, subject)) {
        return json({ error: 'only the circle’s founder can create a channel' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
      const name = text(body.name, 40);
      if (!name) {
        return json({ error: 'name is required (≤40 chars)' }, 400);
      }
      // Optional, and an omitted one stays omitted: a channel with no description renders without a
      // line rather than borrowing the default stream's.
      const description = body.description === undefined ? undefined : text(body.description, 200);
      const created = await ctx.store.createChannel({
        circleId: channelsCircleId,
        name,
        ...(description ? { description } : {}),
        createdBy: membership.persona,
      });
      if (created === 'name-taken') {
        return json({ error: 'a channel with that name already exists in this circle' }, 409);
      }
      return json({ channel: created }, 201);
    }

    // Rename a channel / change its description. Same authority as creating one, because it is the
    // same power: whoever decides a channel exists decides what it is called and what it says it is for.
    // POST rather than PATCH to match `/circles/:id/display`, the other founder-gated edit: nothing
    // else in this service or its client speaks PATCH, and a method no rail has exercised is a
    // CORS/proxy question rather than a design improvement.
    // ⚠️ `exec` returns **null**, not undefined — a `!== undefined` guard here let every POST fall
    // into this branch and throw on the destructure.
    const channelEdit = /^\/circles\/([0-9a-f-]+)\/channels\/([0-9a-f-]+)$/.exec(pathname);
    if (request.method === 'POST' && channelEdit !== null) {
      const editCircleId = channelEdit[1] as string;
      const editChannelId = channelEdit[2] as string;
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const circle = await ctx.store.getCircle(editCircleId);
      if (!circle) {
        return json({ error: 'no such circle' }, 404);
      }
      const membership = await ctx.store.getMembership(editCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to edit a channel' }, 403);
      }
      if (!holdsFounderAuthority(circle, membership, subject)) {
        return json({ error: 'only the circle’s founder can edit a channel' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
      // A name key that is present must be usable: sending `name: ''` is an attempt to rename to
      // nothing, which is a bad request rather than "leave it alone".
      const name = body.name === undefined ? undefined : text(body.name, 40);
      if (body.name !== undefined && name === undefined) {
        return json({ error: 'name must be 1–40 chars' }, 400);
      }
      /**
       * `null` clears the description, an omitted key leaves it unchanged, and a blank string means
       * the same as `null` — the sheet sends whatever is in the field, and a field the user emptied is
       * a description they removed.
       */
      const description =
        body.description === undefined
          ? undefined
          : body.description === null || (typeof body.description === 'string' && body.description.trim().length === 0)
            ? null
            : text(body.description, 200);
      if (body.description !== undefined && description === undefined) {
        return json({ error: 'description must be ≤200 chars' }, 400);
      }
      if (name === undefined && description === undefined) {
        return json({ error: 'nothing to change' }, 400);
      }
      const updated = await ctx.store.updateChannel({
        circleId: editCircleId,
        channelId: editChannelId,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
      });
      if (updated === 'not-found') {
        return json({ error: 'channel not found in this circle' }, 404);
      }
      if (updated === 'name-taken') {
        return json({ error: 'a channel with that name already exists in this circle' }, 409);
      }
      return json({ channel: updated });
    }

    const displayCircleId = /^\/circles\/([0-9a-f-]+)\/display$/.exec(pathname)?.[1];
    if (request.method === 'POST' && displayCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const circle = await ctx.store.getCircle(displayCircleId);
      if (!circle) {
        return json({ error: 'no such circle' }, 404);
      }
      const membership = await ctx.store.getMembership(displayCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to change it' }, 403);
      }
      if (!holdsFounderAuthority(circle, membership, subject)) {
        return json({ error: 'only the circle’s founder can change how it appears' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { displayChar?: unknown };
      const raw = typeof body.displayChar === 'string' ? body.displayChar.trim() : undefined;
      if (raw === undefined || raw.length === 0) {
        return json({ error: 'displayChar is required' }, 400);
      }
      // One grapheme, so an emoji counts — including the multi-codepoint ones. The length cap is a
      // guard on the input before segmenting it, not the rule.
      if (raw.length > 32 || graphemeCount(raw) !== 1) {
        return json({ error: 'displayChar must be a single character' }, 400);
      }
      await ctx.store.setCircleDisplayChar(displayCircleId, raw);
      return json({ circle: publicCircle((await ctx.store.getCircle(displayCircleId)) ?? circle) });
    }

    // ── Self-service invites ─────────────────────────────────────────────────────────────────
    //
    // A Compact circuit cannot read Cardano's ledger, so a gated circle's policy lives here and the
    // chain enforces only what it can see: that the joiner holds an unspent invite. See
    // `docs/BOUNDED_STATE_ARCHITECTURE.md` §"Gating a circle is an **invite**".
    //
    // **Minted on demand, one per qualifying wallet.** The founder delegates by calling
    // `setInviteAuthority` with the commitment this deployment publishes, and from then on the sponsor
    // host proves an `issueInvite` call per claim. Nothing is stocked ahead of time, so this service
    // holds no unissued codes and a circle cannot run dry between a founder's top-ups.
    //
    // ⚠️ **It could not do this until 2026-09-10** — `setInvite` is moderator-gated and proving stays
    // on device, so the original design had the founder pre-mint a pool and upload the secrets. What
    // changed is `circle.compact`'s `inviteAuthority` (a narrow, revocable, non-moderator authority)
    // plus a host that can build and prove a contract call.

    const invitePolicyCircleId = /^\/circles\/([0-9a-f-]+)\/invite-policy$/.exec(pathname)?.[1];
    if (invitePolicyCircleId !== undefined && (request.method === 'GET' || request.method === 'POST')) {
      const attestorPorts = ctx.inviteAttestor;
      if (!attestorPorts) {
        return json({ error: 'this deployment has no invite attestor configured' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const circle = await ctx.store.getCircle(invitePolicyCircleId);
      if (!circle) {
        return json({ error: 'no such circle' }, 404);
      }
      if (request.method === 'GET') {
        // Readable by anyone signed in, deliberately: someone deciding whether to request an
        // invite has to be able to see what is being asked of them, and the rule is not a secret —
        // it is the circle's entry requirement.
        const stored = await ctx.store.getCircleInvitePolicy(invitePolicyCircleId);
        // Answered whether or not a policy exists, because the founder needs it *before* there is
        // one: delegating and choosing a rule are two separate acts and either can come first.
        // Cached on the row once set, so the usual read costs no subrequest.
        const authorityCommitment =
          stored?.authorityCommitment ??
          (await attestorPorts.authorityCommitment(invitePolicyCircleId).catch((error: unknown) => {
            // Not fatal — the policy itself is the answer to this request. Logged rather than
            // swallowed because a missing commitment and an unreachable host render identically.
            console.log(`[invite] could not read the authority commitment: ${String(error)}`);
            return null;
          }));
        return json({
          // A **set**: anyone who meets one of these may join (`accountSatisfiesAny`). Empty and
          // absent are distinct — absent is "no self-service here", empty is a circle whose only
          // rule was the withdrawn `drep-any` and which now admits nobody until its founder chooses
          // again. Both refuse a claim; only one is something the founder half-did.
          rules: stored?.rules ?? null,
          // What the founder must post on chain with `setInviteAuthority` to turn this on. Whether
          // they *have* is a fact about the contract, not about this row — only a chain read of the
          // circle's `inviteAuthority` cell answers that, and the app does it natively.
          authorityCommitment,
        });
      }
      const membership = await ctx.store.getMembership(invitePolicyCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to change it' }, 403);
      }
      if (!holdsFounderAuthority(circle, membership, subject)) {
        return json({ error: 'only the circle’s founder can set who may join' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { rules?: unknown };
      // An **empty array** closes the self-service path, which is what the app sends when a founder
      // deselects everything. Distinct from a missing field, which is a malformed request: "turn
      // this off" is a thing to say deliberately, not something a dropped key should accomplish.
      if (Array.isArray(body.rules) && body.rules.length === 0) {
        await ctx.store.clearCircleInvitePolicy(invitePolicyCircleId);
        return json({ rules: null });
      }
      if (!Array.isArray(body.rules)) {
        return json({ error: 'rules must be an array (empty to remove the policy)' }, 400);
      }
      const submitted: { kind: string; param: string | null }[] = [];
      for (const raw of body.rules) {
        const entry = raw as { kind?: unknown; param?: unknown };
        const kind = text(entry.kind, 40);
        if (kind === undefined) {
          return json({ error: 'each rule needs a kind' }, 400);
        }
        submitted.push({ kind, param: entry.param === undefined || entry.param === null ? null : text(entry.param, 200) ?? null });
      }
      const parsed = parseInvitePredicates(submitted);
      if (!parsed.ok) {
        return json({ error: `invalid requirement: ${parsed.error}` }, 400);
      }
      // Asked at the moment the policy is set, and stored with it: this is the one request where the
      // founder is certain to want the value, and pinning it means a later read is a row rather than a
      // round trip. A host we cannot reach is refused rather than stored as null — a policy with no
      // authority is a gate that can never open, and saying so now is cheaper than at the first claim.
      let authorityCommitment: string;
      try {
        authorityCommitment = await attestorPorts.authorityCommitment(invitePolicyCircleId);
      } catch (error) {
        console.log(`[invite] could not read the authority commitment: ${String(error)}`);
        return json({ error: 'could not reach the invite authority; try again shortly' }, 503);
      }
      const rules = parsed.predicates.map((predicate: InvitePredicate) => ({
        kind: predicate.kind,
        param: invitePredicateParam(predicate),
      }));
      await ctx.store.setCircleInvitePolicy(invitePolicyCircleId, rules, authorityCommitment);
      return json({ rules, authorityCommitment });
    }

    const inviteChallengeCircleId = /^\/circles\/([0-9a-f-]+)\/invite-challenge$/.exec(pathname)?.[1];
    if (request.method === 'POST' && inviteChallengeCircleId !== undefined) {
      if (!ctx.inviteAttestor) {
        return json({ error: 'this deployment has no invite attestor configured' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const stored = await ctx.store.getCircleInvitePolicy(inviteChallengeCircleId);
      if (!stored) {
        return json({ error: 'this circle does not issue invites automatically' }, 404);
      }
      // ⚠️ Server-issued, so the requester cannot mint their own. `expiresAtMs` is inside the
      // signed payload rather than merely returned beside it — a replay defence the sender can
      // rewrite is not one.
      const nonce = await ctx.auth.nonces.issue();
      const expiresAtMs = Date.now() + 5 * 60_000;
      return json({
        nonce,
        expiresAtMs,
        payload: inviteChallengePayload({ circleId: inviteChallengeCircleId, nonce, expiresAtMs }),
      });
    }

    const inviteClaimCircleId = /^\/circles\/([0-9a-f-]+)\/invite-claim$/.exec(pathname)?.[1];
    if (request.method === 'POST' && inviteClaimCircleId !== undefined) {
      const attestor = ctx.inviteAttestor;
      if (!attestor) {
        return json({ error: 'this deployment has no invite attestor configured' }, 404);
      }
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const stored = await ctx.store.getCircleInvitePolicy(inviteClaimCircleId);
      if (!stored) {
        return json({ error: 'this circle does not issue invites automatically' }, 404);
      }
      // ⚠️ A policy row with **no rules** admits nobody, and is not the same as no policy: it is a
      // circle whose only rule was the withdrawn `drep-any`. Reported as the founder's to fix, with
      // its own message — "this circle does not issue invites automatically" would send the requester
      // away believing the feature is off.
      if (stored.rules.length === 0) {
        return json({ error: 'this circle has no joining requirement set yet', failure: 'no-rules' }, 409);
      }
      const parsed = parseInvitePredicates(stored.rules);
      if (!parsed.ok) {
        // A stored row we cannot read is our bug, not the caller's, and must not read as a refusal.
        return json({ error: 'this circle’s invite policy is unreadable; the founder must set it again' }, 500);
      }
      const body = (await request.json().catch(() => ({}))) as {
        nonce?: unknown;
        expiresAtMs?: unknown;
        stakeAddressBech32?: unknown;
        stakeAddressHex?: unknown;
        signature?: unknown;
        key?: unknown;
      };
      const nonce = text(body.nonce, 100);
      const stakeAddressBech32 = text(body.stakeAddressBech32, 120);
      const stakeAddressHex = text(body.stakeAddressHex, 120);
      const signature = text(body.signature, 8000);
      const key = text(body.key, 2000);
      const expiresAtMs = typeof body.expiresAtMs === 'number' ? body.expiresAtMs : undefined;
      if (
        nonce === undefined ||
        stakeAddressBech32 === undefined ||
        stakeAddressHex === undefined ||
        signature === undefined ||
        key === undefined ||
        expiresAtMs === undefined
      ) {
        return json({ error: 'nonce, expiresAtMs, stakeAddressBech32, stakeAddressHex, signature and key are required' }, 400);
      }
      // Expiry before the nonce is consumed: an expired request should not burn a nonce the caller
      // could still have used in time.
      if (Date.now() > expiresAtMs) {
        return json({ error: 'the challenge expired; ask for another' }, 400);
      }
      // ⚠️ Consumed **before** the signature is checked, exactly as the bug-report path claims its
      // nonce first: a valid signature over a spent nonce must fail, so the burn cannot come after.
      if (!(await ctx.auth.nonces.consume(nonce))) {
        return json({ error: 'unknown or already-used challenge' }, 400);
      }
      const expected = inviteChallengePayload({ circleId: inviteClaimCircleId, nonce, expiresAtMs });
      // Both halves: the payload is the one we issued (P2 alone would accept any signature this
      // wallet ever made, including the Koios and SteelSwap challenges), and the key owns the
      // address the predicate is about to be evaluated against.
      if (!(await attestor.verify({ signatureHex: signature, keyHex: key, addressHex: stakeAddressHex, expectedPayload: expected }))) {
        return json({ error: 'signature did not prove control of that stake address' }, 403);
      }
      // Already holds one? Hand back the same code rather than minting another. A user who lost the
      // response, or tapped twice, must not cost the circle a second on-chain invite.
      //
      // ⚠️ A `pending` row is *not* a code to return: its commitment never reached the chain, so
      // handing it over produces a join that fails as "no such invite". It is re-minted below with the
      // same secret, which is also what recovers a claim whose mint died mid-flight.
      const existing = await ctx.store.getClaimedCircleInvite(inviteClaimCircleId, stakeAddressBech32);
      if (existing !== undefined && existing.chainStatus === 'confirmed') {
        return json({ invite: encodeCircleInvite(fromHex(existing.secret)), reissued: true });
      }
      const circle = await ctx.store.getCircle(inviteClaimCircleId);
      const contractAddress = circle?.chain?.chainId;
      if (contractAddress === undefined) {
        // The circle has no contract, so there is no `invites` set to write into. Its founder's
        // problem, not the requester's — the same class of refusal an empty pool used to be.
        return json({ error: 'this circle is not on chain yet, so it cannot issue invites', failure: 'no-contract' }, 409);
      }
      const lookup = await attestor.accountFacts(stakeAddressBech32);
      if (!lookup.ok) {
        // ⚠️ 503, never 403. We could not ask — telling someone they do not qualify because our
        // provider was rate-limited is the failure this distinction exists to prevent.
        return json({ error: 'could not check that stake address against the chain; try again shortly' }, 503);
      }
      if (lookup.facts === null) {
        return json({ error: 'the chain has never seen that stake address', failure: 'stake-key-not-registered' }, 403);
      }
      const verdict = accountSatisfiesAny(parsed.predicates, lookup.facts);
      if (!verdict.ok) {
        // ⚠️ **Every failure, not the first.** With several requirements "you do not qualify" is not
        // an answer — the useful answer is which of the several things to go and do, and the app
        // renders the list. `failure` stays beside it for the single-rule case every caller already
        // reads, so a circle with one requirement says exactly what it said before.
        return json(
          {
            error: 'that wallet does not meet this circle’s requirements',
            failure: verdict.failures[0],
            failures: verdict.failures,
          },
          403,
        );
      }
      // ⚠️ **Reserved before minting**, and that ordering is the whole concurrency story: two requests
      // from one wallet would otherwise both find no row, both mint, and the loser's insert would fail
      // the unique index afterwards — leaving an invite on chain that nobody was ever handed.
      const secret = existing?.secret ?? randomSecretHex();
      const commitment = existing?.commitment ?? toHex(inviteCommitment(fromHex(secret)));
      if (existing === undefined) {
        const reserved = await ctx.store.reserveCircleInvite(
          inviteClaimCircleId,
          { commitment, secret },
          stakeAddressBech32,
        );
        if (reserved === 'already-claimed') {
          // Lost the race against ourselves. The winner's row is the answer; re-read rather than
          // reporting a conflict the caller did nothing to cause.
          const now = await ctx.store.getClaimedCircleInvite(inviteClaimCircleId, stakeAddressBech32);
          return now !== undefined && now.chainStatus === 'confirmed'
            ? json({ invite: encodeCircleInvite(fromHex(now.secret)), reissued: true })
            : json({ error: 'an invite for that wallet is still being issued; try again shortly' }, 503);
        }
      }
      let minted: 'issued' | 'not-delegated';
      try {
        minted = await attestor.mint({ circleId: inviteClaimCircleId, contractAddress, commitment });
      } catch (error) {
        // The reservation is dropped so the wallet can try again — it holds no code and nothing is on
        // chain. Logged as well as answered: this is the only place a mint failure is recorded, and a
        // 503 alone would make "the host is down" and "this circle never delegated" look the same.
        console.log(`[invite] minting for circle ${inviteClaimCircleId} failed: ${String(error)}`);
        await ctx.store.releaseCircleInvite(inviteClaimCircleId, commitment);
        return json({ error: 'could not issue an invite right now; try again shortly' }, 503);
      }
      if (minted === 'not-delegated') {
        // 409, not 403: they qualified. The circle's founder has not called `setInviteAuthority` with
        // our commitment (or has withdrawn it), which they can fix and the requester cannot.
        await ctx.store.releaseCircleInvite(inviteClaimCircleId, commitment);
        return json(
          { error: 'this circle has not delegated invites to us; its founder needs to turn that on', failure: 'not-delegated' },
          409,
        );
      }
      await ctx.store.confirmCircleInvite(inviteClaimCircleId, commitment);
      return json({ invite: encodeCircleInvite(fromHex(secret)), reissued: false }, 201);
    }

    const proposalsCircleId = /^\/circles\/([0-9a-f-]+)\/proposals$/.exec(pathname)?.[1];
    if (request.method === 'POST' && proposalsCircleId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const membership = await ctx.store.getMembership(proposalsCircleId, subject);
      if (!membership) {
        return json({ error: 'join the circle to create proposals' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { title?: unknown; body?: unknown };
      const title = text(body.title, 200);
      const content = text(body.body, 10_000) ?? '';
      if (!title) {
        return json({ error: 'title is required (≤200 chars)' }, 400);
      }
      const proposal = await ctx.store.createProposal({
        circleId: proposalsCircleId,
        title,
        body: content,
        author: membership.persona,
      });
      wake(ctx.notify.proposalCreated(proposalsCircleId, proposal, subject));
      return json({ proposal: await ctx.store.getProposal(proposal.id) }, 201);
    }

    const voteProposalId = /^\/proposals\/([0-9a-f-]+)\/vote$/.exec(pathname)?.[1];
    if (request.method === 'POST' && voteProposalId !== undefined) {
      const subject = await subjectOf(request);
      if (!subject) {
        return json({ error: 'authentication required' }, 401);
      }
      const proposal = await ctx.store.getProposal(voteProposalId);
      if (!proposal) {
        return json({ error: 'no such proposal' }, 404);
      }
      if (!(await ctx.store.getMembership(proposal.circleId, subject))) {
        return json({ error: 'join the circle to vote' }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as { value?: unknown };
      if (body.value !== 'yes' && body.value !== 'no') {
        return json({ error: "value must be 'yes' or 'no'" }, 400);
      }
      const result = await ctx.store.castVote({ proposalId: voteProposalId, subject, value: body.value });
      if (result === 'already-voted') {
        return json({ error: 'already voted on this proposal' }, 409);
      }
      wake(ctx.notify.voteCast(proposal.circleId, result, subject));
      return json({ proposal: await ctx.store.getProposal(voteProposalId) });
    }

    return json({ error: 'not found' }, 404);
  };
};
