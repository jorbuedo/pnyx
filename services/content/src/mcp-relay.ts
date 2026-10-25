// Correlation for the MCP relay, kept out of the Durable Object so it is testable without the Workers
// runtime.
//
// The relay is a **dumb pipe**: it forwards JSON-RPC between an agent (streamable HTTP) and a wallet
// (WebSocket) and holds no keys and no tool definitions. The wallet declares its own tools, so the
// relay never becomes authoritative about what the wallet can do — that is the whole reason `tools/list`
// is forwarded rather than answered here.
//
// ⚠️ **It is a confidentiality trust root and not an authority one.** A standard MCP client speaks plain
// HTTP to whatever URL it is given, so there is nowhere to put a shared key — WalletConnect can encrypt
// end to end only because both ends run its SDK. So this code sees the traffic. It cannot *act*: every
// state-changing call still needs the phone to approve it. Do not log payloads here.
//
// **Why the relay assigns its own correlation id.** The agent controls the JSON-RPC `id` and can repeat
// or collide them; two agents on one pairing would then race for each other's replies. The envelope id
// below is ours, monotonic per object, and the agent's `id` is passed through untouched inside the
// frame so the client still matches its own request.

/**
 * Which agent a frame came from, as the relay knows it.
 *
 * ⚠️ **The relay is the only place this can come from.** One Durable Object serves one *identity*, and
 * every agent that identity paired shares it — so the wallet sees one socket and one origin and cannot
 * tell two agents apart by anything in the frame. The Worker has already verified a pairing token to
 * get here, so it knows exactly which pairing is calling; without this the wallet can only apply one
 * set of permissions to all of them, and any per-agent toggle it offered would be advertised and
 * unenforced.
 *
 * ⚠️ **It is the relay's assertion, not the agent's.** It is derived from a verified token in the
 * Worker and the agent has no way to set or alter it — which is what makes it usable as a key for
 * permissions. It is still not an *authority*: every state-changing call is approved on the phone.
 */
export type RelayAgent = {
  readonly pairingId: string
  /** The name the user gave this agent when pairing it, for the wallet's own logs and screens. */
  readonly label: string
}

/** What the relay sends the wallet, and what the wallet answers with. */
export type RelayEnvelope = {
  /** Ours, not the agent's. See the module note. */
  readonly relayId: number
  /** The JSON-RPC frame, verbatim. */
  readonly frame: unknown
  /**
   * Who sent it. Optional because a wallet build older than this field must keep working against a
   * relay that sends it, and because the *reply* direction never carries one — the relay correlates
   * by `relayId` and has no use for it coming back.
   */
  readonly agent?: RelayAgent
}

/**
 * Read the relay's own attribution off the inner request's headers.
 *
 * ⚠️ **These are the Worker's headers, not the agent's.** `relayMcp` verifies the pairing token and
 * then builds the request this reads, so an agent has no way to spell them itself. Absent rather than
 * guessed when the id is missing: a pairing id invented here would key permissions on a value nothing
 * verified, and the wallet knowing it does not know is the safe answer.
 *
 * Lives here rather than in the Durable Object so the spoofing boundary is testable without the
 * Workers runtime.
 */
export const agentFromHeaders = (headers: {get: (name: string) => string | null}): RelayAgent | undefined => {
  const pairingId = headers.get('x-pnyx-pairing-id');
  if (pairingId === null || pairingId === '') return undefined;
  return {pairingId, label: headers.get('x-pnyx-pairing-label') ?? ''};
};

type PendingReply = {
  readonly resolve: (frame: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  /** The agent's own JSON-RPC id, kept so a failure can still be answered under it. */
  readonly clientId: unknown
}

/**
 * A JSON-RPC frame with no `id` is a notification: forward it and answer the agent immediately, because
 * there is no reply to wait for and holding the HTTP request open would stall the client.
 */
export const isNotification = (frame: unknown): boolean =>
  typeof frame === 'object' && frame !== null && (frame as {id?: unknown}).id === undefined;

/** The error an agent gets when the wallet is not connected. Shaped as JSON-RPC so a client can read it. */
export const walletOfflineFrame = (frame: unknown): object => ({
  jsonrpc: '2.0',
  id: (frame as {id?: unknown} | null)?.id ?? null,
  error: {
    code: -32001,
    // Said plainly, because the agent will show this to a person: a backgrounded phone serves nothing,
    // which is the liveness property the design chose rather than a bug to hide.
    message: 'the wallet is not connected — open Pnyx on the paired device and try again',
  },
});

/** The error an agent gets when the wallet accepted the request but never answered. */
export const walletTimeoutFrame = (frame: unknown, ms: number): object => ({
  jsonrpc: '2.0',
  id: (frame as {id?: unknown} | null)?.id ?? null,
  error: {code: -32002, message: `the wallet did not answer within ${ms}ms`},
});

/**
 * How long to hold an agent's HTTP request open waiting for the wallet.
 *
 * ⚠️ Generous on purpose: a tool call can require a human to approve it on the phone, and a proving
 * call can take seconds on a mid-range device (`castVote` measured 2.4 s host-side). Too short turns an
 * approval prompt into a failed call the agent then retries, which is how a user gets asked twice.
 */
export const DEFAULT_REPLY_TIMEOUT_MS = 120_000;

/** Parse what the wallet sent back over the socket, refusing anything that is not our envelope. */
export const parseEnvelope = (raw: string): RelayEnvelope | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const {relayId, frame} = value as {relayId?: unknown; frame?: unknown};
  if (typeof relayId !== 'number' || !Number.isInteger(relayId) || relayId < 0) return undefined;
  if (frame === undefined) return undefined;
  return {relayId, frame};
};

/**
 * The correlation core: everything the relay does except owning sockets.
 *
 * Separated from the Durable Object so it is testable at all — the DO needs `WebSocketPair`, which does
 * not exist outside the Workers runtime, and the logic worth covering (ids, timeouts, a wallet
 * disappearing mid-request, a late or malformed reply) is all here.
 */
export type RelayCore = {
  /** Forward an agent frame and resolve with the wallet's reply, or with an error frame. */
  readonly request: (frame: unknown, agent?: RelayAgent) => Promise<unknown>;
  /** Feed one raw socket message in. Unparseable or unclaimed frames are dropped, not thrown. */
  readonly onWalletMessage: (raw: string) => void;
  /** The wallet's socket closed: fail every waiter now rather than making each wait out its timeout. */
  readonly onWalletGone: () => void;
  readonly pendingCount: () => number;
};

export type RelayCoreDeps = {
  /** Send an envelope to the wallet. Returns false when there is no socket. */
  readonly send: (envelope: RelayEnvelope) => boolean;
  readonly timeoutMs?: number;
};

export const createRelayCore = (deps: RelayCoreDeps): RelayCore => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const pending = new Map<number, PendingReply>();
  let nextRelayId = 1;

  const settle = (relayId: number, frame: unknown): void => {
    const waiter = pending.get(relayId);
    if (waiter === undefined) return;
    pending.delete(relayId);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  };

  const request = (frame: unknown, agent?: RelayAgent): Promise<unknown> => {
    // Carried on a notification too: `notifications/initialized` is a notification, and an agent whose
    // very first frame arrived unattributed would be handled under the wrong permissions.
    const withAgent = agent === undefined ? {} : {agent};
    // A notification has no reply to wait for, and holding the agent's request open would stall its
    // client for the whole timeout.
    if (isNotification(frame)) {
      return Promise.resolve(deps.send({relayId: 0, frame, ...withAgent}) ? undefined : walletOfflineFrame(frame));
    }
    const relayId = nextRelayId++;
    const clientId = (frame as {id?: unknown} | null)?.id ?? null;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => settle(relayId, walletTimeoutFrame(frame, timeoutMs)), timeoutMs);
      pending.set(relayId, {resolve, timer, clientId});
      // Checked after registering, so a synchronous send failure still resolves through one path.
      if (!deps.send({relayId, frame, ...withAgent})) settle(relayId, walletOfflineFrame(frame));
    });
  };

  return {
    request,
    onWalletMessage: (raw) => {
      const envelope = parseEnvelope(raw);
      // Unparseable, or an id nobody is waiting on — a late reply after a timeout. Dropped rather than
      // fatal: one malformed frame must not take the socket down for every other pending call.
      if (envelope === undefined) return;
      settle(envelope.relayId, envelope.frame);
    },
    onWalletGone: () => {
      for (const [relayId, waiter] of [...pending]) {
        // Answered under the AGENT's id, not the relay's — an earlier version used the relay id here,
        // which would have replied to a JSON-RPC request the client never sent.
        settle(relayId, walletOfflineFrame({id: waiter.clientId}));
      }
    },
    pendingCount: () => pending.size,
  };
};
