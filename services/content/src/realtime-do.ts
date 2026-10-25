// The Durable Object behind the realtime plane: one hub per identity, holding that identity's open
// sockets.
//
// Addressed by `idFromName(subject)`, and the Worker resolves the subject from a verified ticket before
// routing here — so a client can only ever reach its own hub, and this class never sees a credential.
//
// **Hibernation, not a held isolate.** `state.acceptWebSocket` hands the socket to the runtime, which
// evicts the object while the connection is idle and revives it on a message. A chat socket is idle
// almost all the time, so the alternative — keeping an isolate alive per connected user — is the
// difference between a signalling plane that is free at this scale and one that bills for waiting.
//
// **No storage.** The hub keeps nothing: events are signals, and a client that missed one refetches on
// reconnect (see `realtime.ts`). The class is still declared under `new_sqlite_classes` in the
// migration, which is what makes Durable Objects available without a paid plan.
import { encodeFrame, type RealtimeEvent } from './realtime.js';

/** The subset of the Durable Object platform this class uses. Typed locally so the service builds
 * without `@cloudflare/workers-types` in every consumer. */
type HibernatableState = {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  /** Optional so this class still runs on a runtime without it — `webSocketMessage` answers there. */
  setWebSocketAutoResponse?(pair: unknown): void;
};

/** Declared rather than imported, for the same reason `HibernatableState` is. */
declare const WebSocketRequestResponsePair: (new (request: string, response: string) => unknown) | undefined;

export class RealtimeHub {
  constructor(private readonly state: HibernatableState) {
    // Let the runtime answer `ping` on this object's behalf. The client heartbeats every 25 seconds
    // to hold a carrier NAT mapping open (see the app's `realtime/client.ts`), and a message is what
    // revives a hibernated object — so without this, the fix for the flap would bill a wake per
    // device per 25 seconds to send four bytes.
    if (state.setWebSocketAutoResponse !== undefined && typeof WebSocketRequestResponsePair !== 'undefined') {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Publish: the Worker forwards an event for this subject.
    if (request.method === 'POST' && pathname === '/publish') {
      const event = (await request.json().catch(() => undefined)) as RealtimeEvent | undefined;
      if (event === undefined || typeof event.kind !== 'string') {
        return new Response(JSON.stringify({ error: 'event is required' }), { status: 400 });
      }
      const frame = encodeFrame(event);
      let delivered = 0;
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(frame);
          delivered += 1;
        } catch {
          // A socket the runtime has not yet reaped. Skipped rather than fatal: the remaining
          // sockets are the point, and this identity's other device should still be woken.
        }
      }
      return new Response(JSON.stringify({ delivered }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Upgrade: the Worker has already authenticated the caller as this hub's subject.
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ error: 'expected a websocket upgrade' }), { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Client → server messages.
   *
   * The protocol is one-directional by design: the client has authenticated REST endpoints for
   * everything it can *do*, so a socket that accepted commands would be a second, weaker write path.
   * `ping` exists only so a client can keep a NAT mapping alive and prove liveness.
   *
   * On a runtime with auto-response the constructor answers pings without waking this object, so a
   * ping never reaches here. This is the fallback for a runtime without it, and answers identically.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string' && message === 'ping') {
      try {
        ws.send('pong');
      } catch {
        // Closing underneath us; nothing to do.
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // 1006 is an abnormal close the peer never sent; closing back with it is a protocol error.
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {
      // Already gone.
    }
  }
}

/** The Durable Object namespace shape this service needs from the environment. */
export type RealtimeNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/**
 * Publisher over the DO namespace.
 *
 * Failures are logged and swallowed: a signal that did not arrive means the client refetches on its
 * next connect or screen focus, whereas letting this reject would fail the post/vote/settlement that
 * triggered it. The write is the product; the notification is a convenience.
 */
export const durableObjectPublisher = (namespace: RealtimeNamespace, log: (message: string) => void) => ({
  publish: async (subject: string, event: RealtimeEvent): Promise<void> => {
    try {
      const hub = namespace.get(namespace.idFromName(subject));
      await hub.fetch(
        new Request('https://realtime.invalid/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        }),
      );
    } catch (error) {
      log(`publish ${event.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
