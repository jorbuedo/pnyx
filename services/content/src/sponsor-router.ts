// Entry point for the sponsor host's front door: one tunnel, one token, N wallet processes.
//
// Run:
//   SPONSOR_TOKEN=<shared secret> SPONSOR_NETWORKS=preview:3401,preprod:3402,mainnet:3403 \
//   SPONSOR_DEFAULT_NETWORK=preprod PORT=3400 \
//   bun services/content/src/sponsor-router.ts
//
// **Why this process exists.** `@midnight-ntwrk/midnight-js-network-id` keeps the network in a
// module-level mutable global and reads it when a transaction is *built*
// (`Transaction.fromParts(getNetworkId(), …)` in `midnight-js-contracts`). Two wallets on two networks
// in one process therefore share one network id, and the one that booted last decides what the other
// stamps. So each network gets its own `sponsor-server.ts` on its own loopback port, and this routes to
// them. It holds no wallet, no seed, no ledger and no state — which is what keeps it boring.
//
// **It takes port 3400**, the port `cloudflared` already points at, so the tunnel's ingress rule does
// not change when a network is added. The wallets move to 3401+.
//
// **The token is the same shared secret** the Worker already holds and the wallets already require, so
// a request is authenticated twice and neither hop trusts the other's say-so. A tunnel is not
// authentication; nor is being on loopback.
import { createJournalLog, underSystemd } from './journal-log.js';
import { SPONSOR_FAILURE_STATUS, sponsorFailure } from './sponsor-failure.js';
import { hostState, isServing } from './sponsor-host-state.js';
import {
  parseRoutingTable,
  requestedNetwork,
  routeFor,
  type RoutingTable,
  type SponsorRoute,
} from './sponsor-routing.js';

const journal = createJournalLog('sponsor-router', { underSystemd: underSystemd(process.env) });
const log = journal.info;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
};

const port = Number(process.env.PORT ?? 3400);
const token = required('SPONSOR_TOKEN');
const parsed = parseRoutingTable(required('SPONSOR_NETWORKS'), process.env.SPONSOR_DEFAULT_NETWORK);
if (!parsed.ok) {
  // Refusing the boot rather than routing a subset: a host that silently sponsors two of three networks
  // reports healthy while a third of the traffic is refused by name.
  console.error(parsed.message);
  process.exit(1);
}
const table: RoutingTable = parsed.table;

/**
 * How long a proxied call may take.
 *
 * ⚠️ Generous on purpose. `/internal/register` is **awaited** by the caller and balances a transaction
 * with an in-process prover on 2 vCPU; the sponsor host doc measures that in tens of seconds. A short
 * timeout here would turn a slow success into a failure the caller then retries, paying for the same
 * work twice.
 */
const PROXY_TIMEOUT_MS = Number(process.env.SPONSOR_PROXY_TIMEOUT_MS ?? 180_000);

/**
 * The router's own liveness reads.
 *
 * ⚠️ **Deliberately well under the *caller's* timeout, because the fan-out is only as fast as its slowest
 * wallet.** The content service's `sponsorProbe` gives this host 5 s; at a 5 s probe timeout a single
 * cold-syncing wallet took the whole budget and Cloudflare's own probe timed out, so the public status
 * page read `failing` while preprod was serving perfectly (2026-08-28, first boot of three networks).
 * Two seconds leaves room for the round trip and for a second slow network.
 */
const PROBE_TIMEOUT_MS = Number(process.env.SPONSOR_PROBE_TIMEOUT_MS ?? 2_000);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const baseOf = (route: SponsorRoute) => `http://127.0.0.1:${route.port}`;

/**
 * One wallet's answer to a GET, or why it could not be read.
 *
 * A wallet that is still cold-syncing answers 503 with a body, and a wallet whose process is down
 * refuses the connection. Those are different facts and both belong in the report — folding them into
 * one "unavailable" is how a 40-minute cold sync gets mistaken for a crash.
 */
type ProbeBody = { status?: unknown; reasons?: unknown; queued?: unknown } | null;

const probe = async (
  route: SponsorRoute,
  path: string,
  authorize: boolean,
): Promise<{
  network: string;
  port: number;
  httpStatus: number | null;
  body: ProbeBody;
  unreachable?: string;
}> => {
  try {
    const res = await fetch(`${baseOf(route)}${path}`, {
      headers: authorize ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as ProbeBody;
    return { network: route.network, port: route.port, httpStatus: res.status, body };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      network: route.network,
      port: route.port,
      httpStatus: null,
      body: null,
      /**
       * ⚠️ **A timeout and a refused connection are different facts, and on this box the first one is
       * usually not a fault.** A snapshot-less cold sync saturates a core, and the wallet's own `/health`
       * — a synchronous JSON response — then misses a short deadline simply because nothing schedules it.
       * Calling that "unreachable" is what made the public page report `failing` for a host whose other
       * network was fine. It is still not live, so the rollup counts it as not live; what changes is what
       * the operator is told.
       */
      unreachable: timedOut
        ? `busy or still starting: did not answer within ${PROBE_TIMEOUT_MS} ms`
        : `unreachable: ${message(error)}`,
    };
  }
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const fanOut = (path: string, authorize: boolean) =>
  Promise.all(table.routes.map((route) => probe(route, path, authorize)));

/** The rule lives in `sponsor-host-state.ts`, where it can be tested; this only feeds it. */
const rollup = (probes: Awaited<ReturnType<typeof fanOut>>) => hostState(probes);

const handler = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/health') {
    // Unauthenticated and cheap, like the wallets' own. It reports per network because "the sponsor is
    // up" is not a useful answer once there are three of them.
    const probes = await fanOut('/health', false);
    const state = rollup(probes);
    return json(
      {
        // `ok` is "can this host sponsor anything right now". A host still syncing cannot, which is
        // why it is not folded in with `degraded` — that one is serving, just not well.
        ok: isServing(state),
        status: state,
        // Kept for callers written when this host held one network. It is the *default* network, which
        // is what a single-network caller meant by "the sponsor's network".
        network: table.fallback,
        networks: probes.map((one) => ({
          network: one.network,
          status: (one.body?.status as string | undefined) ?? null,
          ok: one.httpStatus === 200,
          queued: (one.body?.queued as number | undefined) ?? null,
          ...(one.unreachable === undefined ? {} : { unreachable: one.unreachable }),
        })),
      },
      // 503 while syncing, with a perfectly good body — the same contract each wallet's own `/status`
      // keeps, and what the Worker's probe documents relying on.
      isServing(state) ? 200 : 503,
    );
  }

  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (request.method === 'GET' && pathname === '/status') {
    const probes = await fanOut('/status', true);
    const state = rollup(probes);
    return json(
      {
        status: state,
        // Reasons are the union, each prefixed by its network — an unprefixed reason in a three-network
        // report names a problem without saying where.
        reasons: probes.flatMap((one) =>
          one.unreachable !== undefined
            ? [`${one.network}: ${one.unreachable}`]
            : ((one.body?.reasons as string[] | undefined) ?? []).map((reason) => `${one.network}: ${reason}`),
        ),
        networks: Object.fromEntries(
          probes.map((one) => [
            one.network,
            one.unreachable === undefined ? one.body : { status: 'failing', reasons: [one.unreachable] },
          ]),
        ),
      },
      state === 'failing' ? 503 : 200,
    );
  }

  // ⚠️ **Every inward route has to be named here.** This is a proxy with an explicit allowlist, not a
  // pass-through: a route added to `sponsor-server.ts` and not added here answers `404 not found`
  // from the *router*, two hops from where anyone would look for it. That is exactly what the two
  // invite routes did on their first run — the wallet answered them correctly on its own port and
  // the Worker saw "not found".
  const FORWARDED = ['/internal/submit', '/internal/register', '/internal/invite-authority', '/internal/issue-invite'];
  if (request.method !== 'POST' || !FORWARDED.includes(pathname)) {
    return json({ error: 'not found' }, 404);
  }

  // Read once: the body is up to ~5 MB of base64 and is forwarded verbatim, so nothing here re-encodes
  // it. Parsed only to find `network` when the header did not carry one.
  const raw = await request.text();
  let bodyNetwork: unknown;
  try {
    bodyNetwork = (JSON.parse(raw) as { network?: unknown }).network;
  } catch {
    // Not this hop's job to validate the payload — the wallet answers 400 with the real reason. Logged
    // so a caller sending junk is visible here rather than only two hops away.
    journal.warn(`a submission body was not JSON (${raw.length} bytes); forwarding to the default network`);
    bodyNetwork = undefined;
  }

  const requested = requestedNetwork(request.headers.get('x-midnight-network'), bodyNetwork);
  const routed = routeFor(table, requested);
  const requestId = request.headers.get('x-request-id') ?? undefined;
  const req = requestId === undefined ? '' : ` req=${requestId}`;
  if (!routed.ok) {
    journal.warn(`refused ${pathname}: ${routed.message}${req}`);
    return json({ error: routed.message }, 400);
  }
  if (routed.defaulted) {
    // Said out loud: a caller that names no network is one deployed before this host had more than one,
    // and a fallback that is never mentioned is how a stale caller keeps working invisibly for months.
    log(`${pathname} named no network; using the default '${routed.route.network}'${req}`);
  }

  try {
    const res = await fetch(`${baseOf(routed.route)}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
      },
      body: raw,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    // The wallet's status and body pass through untouched: it is the one that knows whether the bytes
    // were refused (400) or the host failed (502), and rewriting either would lose the explanation.
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const detail = timedOut ? `did not answer within ${PROXY_TIMEOUT_MS} ms` : message(error);
    journal.error(`${routed.route.network} wallet ${detail}${req}`);
    // ⚠️ Not a 5xx, however much it looks like one: Cloudflare replaces the body of any 5xx from a
    // tunnel origin, and this sentence is the whole point of the response. See `sponsor-failure.ts`.
    return json(sponsorFailure(`the ${routed.route.network} sponsor wallet ${detail}`), SPONSOR_FAILURE_STATUS);
  }
};

Bun.serve({ port, hostname: '127.0.0.1', fetch: handler });
log(
  `sponsor router on 127.0.0.1:${port} → ${table.routes.map((one) => `${one.network}:${one.port}`).join(', ')}` +
    ` (default ${table.fallback ?? 'none'})`,
);
