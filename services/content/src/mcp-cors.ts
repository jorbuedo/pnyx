/**
 * CORS for the agent endpoint.
 *
 * Its own module because `worker.ts` imports a `.wasm` and cannot be loaded by a test runner — the same
 * reason `push-worker.ts` is separate. What lives here is the policy and the routing *decision*; the
 * worker only carries it out.
 *
 * @module
 */

/**
 * Open to every origin.
 *
 * ⚠️ **`*` is safe here because the credential is never ambient.** The danger in a wide-open CORS
 * policy is the browser attaching the user's credentials *by itself* — a cookie — so that any page can
 * act as them. This endpoint authenticates with a `Bearer` pairing token, which a browser never
 * attaches on its own: a page that does not already hold the token gets a 401, exactly as `curl`
 * would. That is also why `access-control-allow-credentials` is absent and must stay absent — with `*`
 * it is the one combination that would be unsound, and browsers reject it outright.
 *
 * ⚠️ **Everything MCP's HTTP transport needs, not just the JSON basics.** A Streamable HTTP client
 * reads `mcp-session-id` off the response, resumes a stream with `last-event-id`, and ends a session
 * with `DELETE`. A header allowed inbound but not *exposed* outbound is unreadable, and a method
 * missing from the list fails the preflight for that method alone — which is the hardest kind of CORS
 * problem to see, because everything works until the client tries to end its session.
 */
export const MCP_CORS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version, www-authenticate',
  'access-control-max-age': '86400',
};

/**
 * What to do with a request to the agent endpoint, before anything else looks at it.
 *
 * ⚠️ **A preflight must be answered before the credential check, and this is where that is decided.** A
 * browser sends no `Authorization` header on a preflight, so letting one reach the endpoint's 401
 * fails the preflight — the real request is never sent, and the browser reports nothing but
 * "CORS error". Expressed as a decision rather than an `if` buried in the handler so the rule is
 * testable without standing up a Durable Object.
 */
export type McpCorsAction =
  /** Answer immediately with {@link mcpPreflight}; nothing else may run. */
  | 'preflight'
  /** Let the handler run, then put the headers on what it returns. */
  | 'wrap'
  /** Leave it entirely alone — the socket upgrade, whose 101 cannot be re-wrapped. */
  | 'passthrough'

export const mcpCorsAction = (method: string, pathname: string): McpCorsAction => {
  // A WebSocket handshake is not subject to CORS, and a 101 carries a `webSocket` that does not
  // survive being copied into a new Response.
  if (pathname !== '/mcp') return 'passthrough'
  return method === 'OPTIONS' ? 'preflight' : 'wrap'
}

/** The preflight answer: a genuinely body-less 204, which the Workers runtime requires. */
export const mcpPreflight = (): Response => new Response(null, { status: 204, headers: MCP_CORS });

/** Copy a response with the CORS headers on it, keeping its body, status and other headers. */
export const withMcpCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(MCP_CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
