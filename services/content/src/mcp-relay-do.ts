// The Durable Object behind the MCP relay: one object per pairing, owning the wallet's socket and
// delegating every correlation decision to `createRelayCore`.
//
// Addressed by `idFromName(subject)` — the *identity*, not the pairing — and the Worker resolves that
// from a verified bearer token (agent) or realtime ticket (wallet) before routing here, so this class
// never sees a credential, the same arrangement `realtime-do.ts` uses. Per identity rather than per
// pairing because one wallet socket has to serve every agent that identity has paired; the trade is that
// two agents share one object, which is exactly why the correlation id below is the relay's own.
//
// ⚠️ **No hibernation, unlike `RealtimeHub`.** That hub can hibernate because its state is only the
// socket set; this one holds in-flight requests in memory, and an eviction between an agent's request
// and the wallet's reply would drop the reply. An in-flight HTTP response keeps the object alive, so the
// window is small — but `acceptWebSocket` hibernation would widen it for no gain, since an MCP session
// is active by definition while a request is pending.
//
// **No storage, deliberately.** A pending request is worth nothing once the agent has given up, and
// persisting frames would put wallet traffic at rest in our infrastructure — the thing the
// confidentiality note in `mcp-relay.ts` says to avoid.
//
// This class is a socket adapter. Everything worth testing lives in the core.
import {agentFromHeaders, createRelayCore, type RelayCore, walletOfflineFrame} from './mcp-relay.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

export class McpRelay {
  private socket: WebSocket | undefined;
  private readonly core: RelayCore = createRelayCore({
    send: (envelope) => {
      if (this.socket === undefined) return false;
      try {
        this.socket.send(JSON.stringify(envelope));
        return true;
      } catch {
        // Died between the check and the send. Reported as "not sent" so the core answers the agent
        // now rather than making it wait out the timeout.
        return false;
      }
    },
  });

  async fetch(request: Request): Promise<Response> {
    const {pathname} = new URL(request.url);

    // The wallet dials in and stays. One socket per identity: a second connection replaces the first,
    // because two devices answering for one identity would race and the newer one is the one the user is
    // holding.
    if (pathname === '/socket') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({error: 'expected a websocket upgrade'}, 400);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.adopt(server);
      return new Response(null, {status: 101, webSocket: client});
    }

    // The agent's JSON-RPC, forwarded to the wallet and answered with whatever comes back.
    if (pathname === '/mcp' && request.method === 'POST') {
      const frame = await request.json().catch(() => undefined);
      if (frame === undefined) return json({error: 'expected a JSON-RPC frame'}, 400);
      if (this.socket === undefined) return json(walletOfflineFrame(frame));
      const reply = await this.core.request(frame, agentFromHeaders(request.headers));
      // A notification produces no reply, and 202 says so without inventing a body.
      return reply === undefined ? new Response(null, {status: 202}) : json(reply);
    }

    return json({error: 'not found'}, 404);
  }

  /** Take over as the pairing's wallet socket, retiring any previous one. */
  private adopt(socket: WebSocket): void {
    const previous = this.socket;
    this.socket = socket;
    if (previous !== undefined) {
      try {
        previous.close(1000, 'replaced by a newer connection');
      } catch {
        // Already gone. The replacement is what matters and the runtime reaps the old one.
      }
    }
    socket.addEventListener('message', (event) => {
      this.core.onWalletMessage(typeof event.data === 'string' ? event.data : '');
    });
    const drop = () => {
      // Guarded: a replaced socket closing must not clear the socket its replacement installed.
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.core.onWalletGone();
    };
    socket.addEventListener('close', drop);
    socket.addEventListener('error', drop);
  }
}
