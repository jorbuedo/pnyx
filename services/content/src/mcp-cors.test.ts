// CORS on the agent endpoint. The load-bearing case is the preflight: a browser sends no Authorization
// header on one, so answering it with the endpoint's 401 fails the preflight and the real request is
// never sent — the endpoint becomes unreachable from any web client, and the browser reports nothing
// but "CORS error".
import { describe, expect, it } from 'vitest';
import { MCP_CORS, mcpCorsAction, mcpPreflight, withMcpCors } from './mcp-cors.js';

describe('the agent endpoint’s preflight', () => {
  // ⚠️ The rule that makes the endpoint reachable from a browser at all: an OPTIONS is answered
  // *before* anything asks for a credential, because a browser sends none on a preflight and a
  // preflight that is not 2xx means the real request is never sent.
  it('answers OPTIONS itself, ahead of the handler', () => {
    expect(mcpCorsAction('OPTIONS', '/mcp')).toBe('preflight');
    expect(mcpPreflight().status).toBe(204);
    expect(mcpPreflight().headers.get('access-control-allow-origin')).toBe('*');
  });

  it('wraps every other method’s answer', () => {
    for (const method of ['GET', 'POST', 'DELETE']) expect(mcpCorsAction(method, '/mcp')).toBe('wrap');
  });

  // ⚠️ A 101 carries a `webSocket` that does not survive being copied into a new Response, and a
  // WebSocket handshake is not subject to CORS in the first place.
  it('leaves the socket upgrade completely alone', () => {
    expect(mcpCorsAction('GET', '/mcp/socket')).toBe('passthrough');
    expect(mcpCorsAction('OPTIONS', '/mcp/socket')).toBe('passthrough');
  });

  // A method missing from the list fails the preflight for that method alone, which is the hardest
  // kind of CORS problem to see: everything works until the client tries to end its session.
  it('allows the methods MCP’s HTTP transport actually uses', async () => {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      expect(MCP_CORS['access-control-allow-methods']).toContain(method);
    }
  });

  // A client reads the session id off the *response*, so allowing the header inbound is only half of it.
  it('exposes the headers a client has to read back', () => {
    expect(MCP_CORS['access-control-expose-headers']).toContain('mcp-session-id');
    expect(MCP_CORS['access-control-allow-headers']).toContain('mcp-session-id');
    expect(MCP_CORS['access-control-allow-headers']).toContain('last-event-id');
  });

  // ⚠️ `*` plus credentials is the one unsound combination, and browsers refuse it outright. The
  // endpoint's credential is a bearer token a browser never attaches by itself, so it is never needed.
  it('never claims to allow credentials', () => {
    expect(Object.keys(MCP_CORS)).not.toContain('access-control-allow-credentials');
  });
});

describe('withMcpCors', () => {
  it('adds the headers without losing the body or the status', async () => {
    const wrapped = withMcpCors(
      new Response(JSON.stringify({ error: 'a pairing token is required' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="pnyx-mcp"' },
      }),
    );
    expect(wrapped.status).toBe(401);
    expect(await wrapped.json()).toEqual({ error: 'a pairing token is required' });
    expect(wrapped.headers.get('access-control-allow-origin')).toBe('*');
    // Kept, and exposed: it is how a client discovers it needs a credential rather than reporting an
    // opaque failure.
    expect(wrapped.headers.get('www-authenticate')).toBe('Bearer realm="pnyx-mcp"');
    expect(MCP_CORS['access-control-expose-headers']).toContain('www-authenticate');
  });
});
