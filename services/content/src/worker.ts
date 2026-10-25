// Cloudflare Worker entry for the Pnyx content service (CF migration phase 2).
// routes.ts is already Fetch-API, so this wraps the same handler with Worker-native
// backends: D1 content store, D1 nonce store, a stable JWT key from a secret, and a
// dry-run push sender. The chain mirror stays local (disabled here; /chain/* is
// tunneled to the local chain service), and artifacts are served from R2 later.
import type { ChainMirror } from './chain.js';
import { importJWK, jwtVerify } from 'jose';
import { loadJwtKeys } from './auth.js';
// A `.wasm` import gives workerd a compiled WebAssembly.Module; wrangler bundles the file.
// Built by `bun run build:wasm` (see services/content/README.md) — gitignored, not committed.
import identityWasm from '../wasm/identity-row.wasm';
import { fetchContractState, type IndexerEndpoint } from './midnight-indexer.js';
import { refuseContractAddress, refuseContractTemplate } from './identity-contract-check.js';
import { createStateReader, type StateReader } from './row-decoder.js';
import { createD1ContentStore } from './d1-store.js';
import { DM_RETENTION, runDmRetentionSweep } from './dm-retention.js';
import { createBugReportPorts } from './bug-report-worker.js';
import { createInviteAttestorPorts } from './circle-invite-worker.js';
import { createD1NonceStore } from './nonce-d1.js';
import { createNotifier } from './notifications.js';
import { type CloudflareRateLimiter, cloudflareRateLimiter, createMemoryRateLimiter } from './rate-limit.js';
import { durableObjectPublisher, type RealtimeNamespace } from './realtime-do.js';
import { forwardingChainMirror } from './sponsor-client.js';
import { createWorkerPushSender } from './push-worker.js';
import { mcpCorsAction, mcpPreflight, withMcpCors } from './mcp-cors.js';
import { createMcpPairingService } from './mcp-pairing.js';
import { createHandler, REALTIME_AUDIENCE } from './routes.js';

export interface Env {
  DB: D1Database;
  /** ES256 signing key, PKCS#8 PEM (wrangler secret). */
  JWT_PRIVATE_KEY: string;
  /** The origin the login challenge binds to (e.g. pnyx.pxkq.uk). */
  AUTH_DOMAIN: string;
  MIDNIGHT_NETWORK: string;
  /** '1' enables wallet-less dev login (POST /auth/dev). Never on a public origin. */
  DEV_AUTH?: string;
  /** Midnight indexer GraphQL endpoint. Must be the indexer for MIDNIGHT_NETWORK's chain. */
  MIDNIGHT_INDEXER_URL?: string;
  /**
   * Blockfrost's `project_id` for {@link MIDNIGHT_INDEXER_URL} (wrangler secret), sent as a header.
   *
   * Absent is correct for an indexer that needs no key — ours on mainnet. Absent against one that
   * does means every identity row read 403s, which refuses every login.
   */
  MIDNIGHT_INDEXER_PROJECT_ID?: string;
  PNYX_CIRCLE_CODE_DIGEST?: string;
  /**
   * Koios base URL for the self-service invite attestor's `account_info` reads.
   *
   * ⚠️ Optional, and its absence 404s the `/circles/:id/invite*` routes. Never defaulted to a
   * public instance: an endpoint we do not operate is rate-limited and shared, and substituting
   * one would turn a config mistake into intermittent wrong answers about people's wallets.
   */
  KOIOS_URL?: string;
  /**
   * `identity.compact`'s **code digest** — the value the artifacts manifest publishes for the build
   * devices prove against, and the same one the sponsor host is configured with.
   *
   * ⚠️ Replaced `PNYX_IDENTITY_CONTRACT_ADDRESS` on 2026-08-25. There is one identity contract per
   * identity, at an address derived from `C`, so a configured address could only ever have served one
   * person. A login names its own contract and this is what proves the contract is ours.
   */
  PNYX_IDENTITY_CODE_DIGEST?: string;
  /** Cloudflare rate limiting binding guarding POST /register (`ratelimits` in wrangler config). */
  REGISTER_LIMITER?: CloudflareRateLimiter;
  TRANSFER_LIMITER?: CloudflareRateLimiter;
  BUG_REPORT_LIMITER?: CloudflareRateLimiter;
  /**
   * R2 bucket holding bug-report blobs (`reports/<day>/<id>.json.gz`).
   *
   * Optional because a deployment without it should 404 the route rather than fail at upload
   * time — and because the bucket has to be created before this can be bound, so "not yet" is a
   * real state this code passes through.
   */
  BUG_REPORTS?: R2Bucket;
  /**
   * The sponsor host behind the Cloudflare Tunnel, and the secret both directions authenticate with.
   * Both unset → this deployment forwards nothing and `/register` + `/chain/submit` stay 503, which is
   * the state before the sponsor box exists.
   */
  SPONSOR_URL?: string;
  SPONSOR_TOKEN?: string;
  /**
   * Google service-account JSON (wrangler secret) for FCM HTTP v1. Absent → notifications are still
   * produced and fanned out, but logged rather than sent.
   */
  FIREBASE_SERVICE_ACCOUNT?: string;
  /** One realtime hub per identity (`RealtimeHub`), declared in wrangler config. */
  REALTIME?: RealtimeNamespace;
  /** One MCP relay per identity (`McpRelay`), declared in wrangler config. */
  MCP_RELAY?: RealtimeNamespace;
}

/**
 * Writes stay local; reads do not.
 *
 * A write mirror needs a funded, synced, stateful host — a sponsor wallet to pay DUST, a long-lived
 * ordered task chain — none of which fits a Worker, so `enabled` stays false and `/register`,
 * `/chain/*` and forum mirroring keep reporting themselves unavailable.
 *
 * **Reading a row is a different problem**: one indexer query plus a wasm decode. That is all login
 * needs, so `rowReads` is true whenever this deployment is configured for it. Without that split a
 * Worker that *could* answer a login still refused every one.
 *
 * Inlined rather than importing @pnyx/chain-client, which would drag the wallet SDK in.
 */
const readOnlyChainMirror = (env: Env, reader: () => StateReader): ChainMirror => {
  const indexerUrl = env.MIDNIGHT_INDEXER_URL;
  const projectId = env.MIDNIGHT_INDEXER_PROJECT_ID;
  const endpointFor = (url: string): IndexerEndpoint => ({
    url,
    ...(projectId === undefined || projectId === '' ? {} : { projectId }),
  });
  const templateDigest = env.PNYX_IDENTITY_CODE_DIGEST;
  const circleDigest = env.PNYX_CIRCLE_CODE_DIGEST;
  const configured = indexerUrl !== undefined && indexerUrl !== '' && templateDigest !== undefined && templateDigest !== '';
  return {
    enabled: false,
    rowReads: configured,
    // A read-only deployment: it can answer a login and nothing else. Saying so beats a silent no-op.
    submitProven: () =>
      Promise.resolve({ accepted: false as const, error: 'this deployment has no sponsor; writes are refused' }),
    ...(templateDigest === undefined ? {} : { identityCodeDigest: templateDigest }),
    ...(circleDigest === undefined ? {} : { circleCodeDigest: circleDigest }),
    // The same wasm decode the identity check uses, pointed at any address. Rejecting when the
    // indexer is unconfigured keeps "we could not look" out of the recorded verdict.
    contractCodeDigestAt: async (address) => {
      if (indexerUrl === undefined || indexerUrl === '') {
        throw new Error('contract digest reads are not configured (MIDNIGHT_INDEXER_URL)');
      }
      const state = await fetchContractState(endpointFor(indexerUrl), address);
      return state === undefined ? undefined : reader().codeDigest(state);
    },
    contractState: async () => new Uint8Array(),
    identityRow: async (identity, contract) => {
      // Rejects rather than returning nothing: "nobody has published" and "we cannot look" differ,
      // and the second must never deny a login as if the identity were unregistered.
      if (!configured) {
        throw new Error('identity row reads are not configured (MIDNIGHT_INDEXER_URL / PNYX_IDENTITY_CODE_DIGEST)');
      }
      // The two rules that make a caller-named contract safe live in `identity-contract-check.ts`,
      // with the argument for why they are sufficient.
      const badAddress = refuseContractAddress(contract);
      if (badAddress !== undefined) throw new Error(badAddress);
      const state = await fetchContractState(endpointFor(indexerUrl as string), contract as string);
      if (state === undefined) {
        throw new Error(`no contract state at ${contract as string}`);
      }
      const stateReader = reader();
      const badTemplate = refuseContractTemplate({
        digest: stateReader.codeDigest(state),
        expected: templateDigest,
      });
      if (badTemplate !== undefined) throw new Error(badTemplate);
      // Sealed to *this* `C`: the decoder errors on a contract sealed to another, which is the second
      // half of the argument.
      return stateReader.row(state, identity);
    },
    submitIdentityRow: () => Promise.reject(new Error('this deployment cannot submit transactions')),
    whenIdle: async () => {},
  };
};

/**
 * The signing key, loaded once per isolate. Shared because both the handler (issuing) and the socket
 * upgrade (verifying a ticket) need it, and importing a PKCS#8 key twice per isolate to arrive at the
 * same value is waste with a chance of divergence.
 */
let jwtKeysPromise: ReturnType<typeof loadJwtKeys> | undefined;
const jwtKeys = (env: Env) => {
  jwtKeysPromise ??= loadJwtKeys(env.JWT_PRIVATE_KEY);
  return jwtKeysPromise;
};

type Handler = (
  request: Request,
  hooks?: {readonly keepAlive?: (promise: Promise<unknown>) => void},
) => Response | Promise<Response>;

let handlerPromise: Promise<Handler> | undefined;
// Instantiated at most once per isolate, and only if a login actually arrives — instantiating the
// module costs startup CPU that a request for, say, /circles should not pay.
let stateReader: StateReader | undefined;
const reader = (): StateReader => {
  stateReader ??= createStateReader(identityWasm);
  return stateReader;
};

const buildHandler = async (env: Env): Promise<Handler> => {
  const store = createD1ContentStore({ db: env.DB });
  const { privateKey, publicJwk, kid } = await jwtKeys(env);
  const nonces = createD1NonceStore(env.DB);
  const realtime =
    env.REALTIME === undefined ? undefined : durableObjectPublisher(env.REALTIME, (m) => console.log(`[realtime] ${m}`));
  const notify = createNotifier(
    store,
    createWorkerPushSender(env.FIREBASE_SERVICE_ACCOUNT, (m) => console.log(`[push] ${m}`)),
    (m) => console.log(`[notify] ${m}`),
    ...(realtime === undefined ? [] : [realtime]),
  );
  // An isolate-local window when the binding is absent (e.g. a `wrangler dev` without it): weaker
  // than the real thing, since isolates do not share state, but not nothing.
  const registerLimit =
    env.REGISTER_LIMITER === undefined
      ? createMemoryRateLimiter({ limit: 5, windowMs: 60_000 })
      : cloudflareRateLimiter(env.REGISTER_LIMITER, (m) => console.log(`[ratelimit] ${m}`));
  // Sponsored transfers, keyed on the session subject. Its own binding rather than sharing
  // REGISTER_LIMITER: the two guard different things at different rates, and one key space would let
  // registrations eat a sender's budget.
  const transferLimit =
    env.TRANSFER_LIMITER === undefined
      ? createMemoryRateLimiter({ limit: 10, windowMs: 600_000 })
      : cloudflareRateLimiter(env.TRANSFER_LIMITER, (m) => console.log(`[ratelimit] ${m}`));
  // Bug reports, keyed on the claimed signing address. The bound is generous on purpose: a
  // person hitting several bugs in a session should be able to file all of them, and the cost
  // being guarded is R2 writes rather than sponsor funds.
  const bugReportLimit =
    env.BUG_REPORT_LIMITER === undefined
      ? createMemoryRateLimiter({ limit: 10, windowMs: 600_000 })
      : cloudflareRateLimiter(env.BUG_REPORT_LIMITER, (m) => console.log(`[ratelimit] ${m}`));

  // With a sponsor configured the chain plane becomes available *for writes*: the wallet lives on the
  // other side of the tunnel. Without one, the read-only mirror keeps login working and refuses the
  // write routes, which is exactly the pre-VPS state.
  const sponsorConfigured = env.SPONSOR_URL !== undefined && env.SPONSOR_TOKEN !== undefined;
  const readOnly = readOnlyChainMirror(env, reader);
  const chain = sponsorConfigured
    ? forwardingChainMirror({
        link: { url: env.SPONSOR_URL as string, token: env.SPONSOR_TOKEN as string },
        rowReads: readOnly.rowReads,
        ...(env.PNYX_IDENTITY_CODE_DIGEST === undefined ? {} : { identityCodeDigest: env.PNYX_IDENTITY_CODE_DIGEST }),
        ...(env.PNYX_CIRCLE_CODE_DIGEST === undefined ? {} : { circleCodeDigest: env.PNYX_CIRCLE_CODE_DIGEST }),
        identityRow: readOnly.identityRow,
        contractCodeDigestAt: readOnly.contractCodeDigestAt,
        store,
        log: (m) => console.log(`[sponsor] ${m}`),
      })
    : readOnly;

  return createHandler({
    auth: {
      domain: env.AUTH_DOMAIN,
      network: env.MIDNIGHT_NETWORK,
      nonces,
      jwt: { privateKey, kid, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 60 * 60 },
    },
    publicJwk,
    store,
    devAuth: env.DEV_AUTH === '1',
    chain,
    notify,
    registerLimit,
    transferLimit,
    ...(env.SPONSOR_TOKEN === undefined ? {} : { sponsorToken: env.SPONSOR_TOKEN }),
    ...(sponsorConfigured
      ? { sponsorLink: { url: env.SPONSOR_URL as string, token: env.SPONSOR_TOKEN as string } }
      : {}),
    ...(realtime === undefined ? {} : { realtime }),
    // Both or neither: the index and the blob store are one feature, and a route that could
    // write a row it cannot back with an object would leave a report we can find and not read.
    ...(env.DB === undefined || env.BUG_REPORTS === undefined
      ? {}
      : {
          bugReports: createBugReportPorts({ db: env.DB as never, bucket: env.BUG_REPORTS as never }),
          ...(bugReportLimit === undefined ? {} : { bugReportLimit }),
        }),
    // The self-service invite attestor. `KOIOS_URL` is required rather than defaulted: the repo's
    // third-party RPC policy forbids reaching for a public Koios instance, and a deployment
    // without one should 404 the routes rather than hand people wrong verdicts about their own
    // wallets from a shared, rate-limited endpoint.
    //
    // ⚠️ **And a sponsor, both or neither.** The attestor's output *is* an on-chain invite, and this
    // Worker cannot prove a contract call — so a deployment with Koios but no sponsor host could
    // evaluate a predicate perfectly and then have nothing to hand the person who passed it. Routes
    // that 404 say that; routes that qualify someone and then fail do not.
    ...(env.KOIOS_URL === undefined || !sponsorConfigured
      ? {}
      : {
          inviteAttestor: createInviteAttestorPorts({
            koiosUrl: env.KOIOS_URL,
            mintLink: {
              url: env.SPONSOR_URL as string,
              token: env.SPONSOR_TOKEN as string,
              network: env.MIDNIGHT_NETWORK,
            },
          }),
        }),
    // Only when there is both a database to record pairings in and a relay to reach — otherwise the
    // routes 404 rather than issuing a credential that nothing can use.
    ...(env.DB === undefined || env.MCP_RELAY === undefined
      ? {}
      : {
          mcpPairings: createMcpPairingService(env.DB as never, {
            privateKey,
            publicJwk,
            kid,
            issuer: 'https://pnyx-content-service',
          }),
        }),
  });
};

/**
 * The socket upgrade, handled here rather than in the shared router because it needs the Durable Object
 * namespace — a Worker-only binding. The ticket is verified *before* the hub is addressed, and the hub's
 * name is the ticket's subject, so a client can only ever reach its own.
 */
const upgradeRealtime = async (request: Request, env: Env): Promise<Response> => {
  if (env.REALTIME === undefined) {
    return Response.json({ error: 'realtime is not configured for this deployment' }, { status: 404 });
  }
  const ticket = new URL(request.url).searchParams.get('ticket');
  if (ticket === null || ticket === '') {
    return Response.json({ error: 'ticket is required (POST /realtime/ticket first)' }, { status: 401 });
  }
  let subject: string;
  try {
    const { publicJwk } = await jwtKeys(env);
    const key = await importJWK(publicJwk as never, 'ES256');
    const { payload } = await jwtVerify(ticket, key, {
      issuer: 'https://pnyx-content-service',
      // The session audience is rejected here: only a ticket opens a socket.
      audience: REALTIME_AUDIENCE,
      algorithms: ['ES256'],
    });
    if (typeof payload.sub !== 'string') throw new Error('no subject');
    subject = payload.sub;
  } catch {
    return Response.json({ error: 'invalid or expired ticket' }, { status: 401 });
  }
  return env.REALTIME.get(env.REALTIME.idFromName(subject)).fetch(request);
};

/**
 * The MCP relay's two transport routes, here rather than in the shared router because both need the
 * Durable Object namespace.
 *
 * ⚠️ **Two different credentials, deliberately.** The wallet opens the socket with its own session JWT;
 * an agent posts JSON-RPC with the pairing token it was given. Both resolve to the same identity, and
 * the object is addressed by that identity — so an agent can only ever reach the wallet that paired it,
 * and the relay never sees a credential (it is verified here first).
 */
const relayMcp = async (request: Request, env: Env, pathname: string): Promise<Response> => {
  if (env.MCP_RELAY === undefined) {
    return Response.json({ error: 'the MCP relay is not configured for this deployment' }, { status: 404 });
  }
  // The wallet's socket: authenticated as the identity, exactly like /realtime.
  if (pathname === '/mcp/socket') {
    const ticket = new URL(request.url).searchParams.get('ticket');
    if (ticket === null || ticket === '') {
      return Response.json({ error: 'ticket is required (POST /realtime/ticket first)' }, { status: 401 });
    }
    let subject: string;
    try {
      const { publicJwk } = await jwtKeys(env);
      const key = await importJWK(publicJwk as never, 'ES256');
      const { payload } = await jwtVerify(ticket, key, {
        issuer: 'https://pnyx-content-service',
        audience: REALTIME_AUDIENCE,
        algorithms: ['ES256'],
      });
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      subject = payload.sub;
    } catch {
      return Response.json({ error: 'invalid or expired ticket' }, { status: 401 });
    }
    return env.MCP_RELAY.get(env.MCP_RELAY.idFromName(subject)).fetch(
      new Request(new URL('/socket', request.url), request),
    );
  }

  // The agent's JSON-RPC. Authenticated with the pairing token, which also names the identity.
  const header = request.headers.get('authorization');
  if (header === null || !header.startsWith('Bearer ')) {
    // `WWW-Authenticate` is what lets an MCP client discover it needs a credential rather than
    // reporting an opaque failure.
    return new Response(JSON.stringify({ error: 'a pairing token is required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="pnyx-mcp"' },
    });
  }
  const db = env.DB;
  if (db === undefined) {
    return Response.json({ error: 'agent pairing is not configured for this deployment' }, { status: 404 });
  }
  const { privateKey, publicJwk, kid } = await jwtKeys(env);
  const agent = await createMcpPairingService(db as never, {
    privateKey,
    publicJwk,
    kid,
    issuer: 'https://pnyx-content-service',
  }).verify(header.slice(7));
  if (agent === undefined) {
    return Response.json({ error: 'invalid or revoked pairing token' }, { status: 401 });
  }
  // ⚠️ **The pairing id travels as a header the Worker sets, on a request the agent cannot reach.** The
  // relay object is addressed by *identity*, so every agent an identity paired shares one object and one
  // wallet socket — nothing in the frame distinguishes them. The token verified just above is what does,
  // and this is the only point where that is still known. Without it the wallet can hold one set of
  // permissions for all of an identity's agents and no more.
  const inner = new Request(new URL('/mcp', request.url), request);
  inner.headers.set('x-pnyx-pairing-id', agent.pairingId);
  inner.headers.set('x-pnyx-pairing-label', agent.label);
  return env.MCP_RELAY.get(env.MCP_RELAY.idFromName(agent.subject)).fetch(inner);
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/realtime') {
      return upgradeRealtime(request, env);
    }
    if (pathname === '/mcp' || pathname === '/mcp/socket') {
      // ⚠️ The preflight is answered here, **before** `relayMcp` can ask for a credential a browser
      // does not send on one — see `mcpCorsAction`.
      const action = mcpCorsAction(request.method, pathname);
      if (action === 'preflight') return mcpPreflight();
      const response = await relayMcp(request, env, pathname);
      return action === 'wrap' ? withMcpCors(response) : response;
    }
    // Cache the assembled handler per isolate (key load + wiring once).
    if (handlerPromise === undefined) handlerPromise = buildHandler(env);
    const handler = await handlerPromise;
    try {
      // `ctx.waitUntil` is what lets a route answer before its side effect finishes. Without it the
      // runtime cancels anything still pending once the response is returned — which is exactly how
      // every sponsored transfer was accepted with a 202 and then never forwarded to the sponsor.
      return await handler(request, { keepAlive: (promise) => ctx.waitUntil(promise) });
    } catch (error) {
      // ⚠️ Nothing caught a route's throw before this. The runtime turned it into its own bare 500,
      // which reaches the client with no body worth reading and leaves **no line in the log at all**
      // — a duplicate-Welcome insert looked exactly like the service being unreachable, and took a
      // fetch-level trace to tell apart. The route and method are the minimum needed to know which
      // one failed; the body is never echoed back.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'unhandled route failure',
          method: request.method,
          path: pathname,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      return new Response(JSON.stringify({ error: 'the service failed to handle that request' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },

  /**
   * The retention sweep (`triggers.crons` in wrangler.jsonc).
   *
   * ⚠️ **Nothing else can do this.** Every other deletion in the DM tables is the recipient's or the
   * owner's own act, so an install that never comes back leaves its rows for ever — and a reinstalled
   * one cannot name the packages it published, so it cannot retire them either. See
   * `dm-retention.ts` for the windows and why the key-package cap is a liveness fix.
   *
   * The outcome is logged whether or not it found anything, and per rule. A sweep that says nothing on
   * a quiet run is indistinguishable from a sweep that stopped running, and a single total is
   * indistinguishable from one rule silently ceasing to match.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const store = createD1ContentStore({ db: env.DB });
    // `waitUntil` for the same reason the fetch handler uses it: the runtime cancels work still
    // pending when a handler returns, and a cancelled sweep logs nothing at all. Awaited as well, so
    // the platform's own invocation record reflects whether it finished.
    const sweep = runDmRetentionSweep(store, DM_RETENTION, event, (line) => {
      const text = JSON.stringify(line);
      if (line.level === 'error') console.error(text);
      else console.log(text);
    });
    ctx.waitUntil(sweep);
    await sweep;
  },
};

export { RealtimeHub } from './realtime-do.js';
export { McpRelay } from './mcp-relay-do.js';
