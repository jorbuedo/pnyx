// Which wallet process a sponsored submission belongs to — the pure half of the sponsor router.
//
// **Why a router exists at all.** `@midnight-ntwrk/midnight-js-network-id` keeps the network in a
// module-level mutable global and reads it at *operation* time: `midnight-js-contracts` calls
// `Transaction.fromParts(getNetworkId(), …)` when it builds the balancing transaction. So two networks
// in one process share one network id, and whichever wallet booted last decides what the other one
// stamps its transactions with. That is not a configuration problem with a workaround — it is the
// library's shape. One wallet process per network, and a router in front.
//
// This module is the routing rule with no I/O, so it can be tested without a wallet or a socket.

/** A configured wallet process: which network it holds and where it listens. */
export type SponsorRoute = {
  readonly network: string;
  /** Loopback port. Nothing here is reachable from outside the box. */
  readonly port: number;
};

export type RoutingTable = {
  readonly routes: readonly SponsorRoute[];
  /**
   * Where a request that names no network goes.
   *
   * ⚠️ **Present so a Worker deployed before this change keeps working.** The old body carried no
   * network at all, and a rollout in which the box updates first must not start refusing live traffic.
   * A defaulted route is logged by the caller, because "it worked" and "it worked by falling back" are
   * different facts.
   */
  readonly fallback: string | null;
};

/**
 * Parse `SPONSOR_NETWORKS`, e.g. `preview:3401,preprod:3402,mainnet:3403`.
 *
 * Refuses rather than skipping a malformed entry: a typo that silently dropped `mainnet` would leave
 * the router answering "mainnet is not configured on this host" for a network the operator believes
 * they deployed, and the box would look healthy the whole time.
 */
export const parseRoutingTable = (
  spec: string,
  fallback: string | undefined,
): {readonly ok: true; readonly table: RoutingTable} | {readonly ok: false; readonly message: string} => {
  const entries = spec
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '');
  if (entries.length === 0) {
    return {ok: false, message: 'SPONSOR_NETWORKS is empty; expected e.g. preview:3401,preprod:3402'};
  }
  const routes: SponsorRoute[] = [];
  const seenNetwork = new Set<string>();
  const seenPort = new Set<number>();
  for (const entry of entries) {
    const [network, rawPort, ...rest] = entry.split(':');
    if (network === undefined || network === '' || rawPort === undefined || rest.length > 0) {
      return {ok: false, message: `SPONSOR_NETWORKS entry '${entry}' is not <network>:<port>`};
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {ok: false, message: `SPONSOR_NETWORKS entry '${entry}' has no valid port`};
    }
    // Both collisions are silent in the direction that matters: two networks on one port would send a
    // preview transaction to the preprod wallet, which is the exact failure this router exists to stop.
    if (seenNetwork.has(network)) return {ok: false, message: `SPONSOR_NETWORKS names '${network}' twice`};
    if (seenPort.has(port)) return {ok: false, message: `SPONSOR_NETWORKS uses port ${port} twice`};
    seenNetwork.add(network);
    seenPort.add(port);
    routes.push({network, port});
  }
  if (fallback !== undefined && fallback !== '' && !seenNetwork.has(fallback)) {
    return {
      ok: false,
      message: `SPONSOR_DEFAULT_NETWORK '${fallback}' is not one of ${[...seenNetwork].join(', ')}`,
    };
  }
  return {ok: true, table: {routes, fallback: fallback === undefined || fallback === '' ? null : fallback}};
};

export type Routed =
  | {readonly ok: true; readonly route: SponsorRoute; readonly defaulted: boolean}
  | {readonly ok: false; readonly message: string};

/**
 * The wallet process for a request.
 *
 * ⚠️ **A network this host does not hold is a 400, not a 202.** Before this existed the wallet accepted
 * every submission and a mismatch died inside `balanceTx` — on 2026-08-28 twice, as
 * `invalid network ID - expect 'preview' found 'preprod'`, minutes after the caller had been told
 * `accepted`. The caller can act on "this host does not sponsor preview"; it cannot act on a 202.
 */
export const routeFor = (table: RoutingTable, requested: string | null): Routed => {
  const known = table.routes.map((one) => one.network).join(', ');
  if (requested === null || requested === '') {
    if (table.fallback === null) {
      return {
        ok: false,
        message: `no network was named and this host has no default; name one of ${known}`,
      };
    }
    const route = table.routes.find((one) => one.network === table.fallback);
    // Unreachable while `parseRoutingTable` guards the pair, and cheap to say rather than assert.
    if (route === undefined) return {ok: false, message: `the default network is not configured; known: ${known}`};
    return {ok: true, route, defaulted: true};
  }
  const route = table.routes.find((one) => one.network === requested);
  if (route === undefined) {
    return {ok: false, message: `this host does not sponsor '${requested}'; it sponsors ${known}`};
  }
  return {ok: true, route, defaulted: false};
};

/**
 * The network a request names: the header first, then the body.
 *
 * The header is authoritative because it is what the router reads without parsing a 4 MB base64 body,
 * and the body is accepted because a JSON field is what a caller can set through any HTTP client. They
 * disagreeing is a caller bug rather than an attack — the wallet process verifies the transaction's own
 * network before it spends anything either way (`sponsor-server.ts`).
 */
export const requestedNetwork = (headerValue: string | null, bodyValue: unknown): string | null => {
  if (typeof headerValue === 'string' && headerValue.trim() !== '') return headerValue.trim();
  if (typeof bodyValue === 'string' && bodyValue.trim() !== '') return bodyValue.trim();
  return null;
};
