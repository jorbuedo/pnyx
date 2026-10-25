/**
 * The wallet side of the MCP relay: hold a socket open, answer the frames that arrive on it.
 *
 * The relay is a dumb pipe, so this is where the tool surface actually lives — an agent's `tools/list`
 * is answered here, from the catalogue, not by the relay. Every frame goes through
 * `@pnyx/mcp-server`'s protocol layer, which routes a `tools/call` into the same connector `resolve`
 * the in-app browser uses.
 *
 * **Why a socket and not a listener.** MCP's client always dials the server, and this app cannot listen
 * — there is no HTTP server in React Native and adding one would mean a native module on both platforms
 * (`docs/MCP_DEV_TOOL_SPEC.md` §4.4). So the app dials out and the relay pipes.
 *
 * ⚠️ **A backgrounded app serves nothing**, and that is the design rather than a bug: the socket closes,
 * the relay answers agents with "the wallet is not connected", and the user is told the same thing in
 * the pairing screen. Reconnecting is the app's job while it is foregrounded.
 *
 * @module
 */

import type {Resolver} from '@pnyx/dapp-connector'
import {
  createMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LocalToolRunner,
  type McpCaller,
} from '@pnyx/mcp-server'
import type {Effect} from 'effect'
import {logger} from '../../logger'
import type {AgentCall, AgentCallOutcome} from './activity'
import type {SocketUrlResult} from './socket-url'

const ORIGIN = 'mcp-host'

/**
 * The origin every agent speaks as, and the one a session is granted to.
 *
 * ⚠️ **URL-shaped, and never taken from the agent.** `normalizeOrigin` calls `new URL()`, so a bare
 * label throws and is then rejected as an invalid session origin with no useful error. Exported because
 * whoever grants the session has to name the same origin the server claims — two spellings would mean a
 * grant that authorises nothing.
 */
export const MCP_AGENT_ORIGIN = 'mcp://agent'

/**
 * What the relay sends and expects back. `relayId` is the relay's own correlation id — never echoed
 * from the frame — so the reply has to carry it back unchanged or the agent's request times out.
 */
type RelayEnvelope = {
  readonly relayId: number
  readonly frame: unknown
  /**
   * Which paired agent sent it, as the **relay** asserts it — see `services/content/src/mcp-relay.ts`.
   *
   * ⚠️ **Nothing in the frame can tell two agents apart.** One relay object serves one identity and
   * every agent that identity paired shares it, so they arrive on one socket under one origin. The
   * Worker verified a pairing token to route the call and this is that fact, carried across; an agent
   * cannot set it. Optional because a relay deployment older than the field sends none, and a wallet
   * that assumed it was there would stop serving against one.
   */
  readonly agent?: {readonly pairingId: string; readonly label: string}
}

/**
 * The attribution, or `undefined` when the relay sent none.
 *
 * ⚠️ **Absent is a real answer and must stay distinguishable from a pairing id.** An unattributed call
 * is one this wallet cannot hold to one agent's permissions; substituting a placeholder id would make
 * it look like a known agent and quietly apply somebody's settings to it.
 */
const readAgent = (value: unknown): {readonly pairingId: string; readonly label: string} | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const {pairingId, label} = value as {pairingId?: unknown; label?: unknown}
  if (typeof pairingId !== 'string' || pairingId.length === 0) return undefined
  return {pairingId, label: typeof label === 'string' ? label : ''}
}

const parseEnvelope = (raw: string): RelayEnvelope | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    logger.debug('mcp dropped an unparseable frame', {origin: ORIGIN, error: String(error)})
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const {relayId, frame, agent} = value as {relayId?: unknown; frame?: unknown; agent?: unknown}
  if (typeof relayId !== 'number' || frame === undefined) {
    logger.debug('mcp dropped a frame with no relay id', {origin: ORIGIN})
    return undefined
  }
  const sender = readAgent(agent)
  return {relayId, frame, ...(sender === undefined ? {} : {agent: sender})}
}

export type McpHostDeps = {
  /**
   * The resolver for the scope a call names — see `McpServerConfig.resolverFor`.
   *
   * ⚠️ Per call, because an agent may be granted several wallets and each has its own connector.
   */
  readonly resolverFor: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => Resolver | {readonly refusal: string}
  /** The runner for the tools the app answers itself, for the scope a call names. Same rule as above. */
  readonly localFor: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => LocalToolRunner | {readonly refusal: string}
  /** Runs one protocol frame in the host app's runtime. */
  readonly runFrame: (effect: Effect.Effect<JsonRpcResponse | null, unknown>) => Promise<JsonRpcResponse | null>
  /** The always-loaded guidance an agent gets from `initialize`. */
  readonly instructions: string
  /**
   * Which tools to advertise. Read per frame rather than captured, so turning a capability off takes
   * effect on the next `tools/list` instead of at the next reconnect.
   */
  readonly toolVisible?: (name: string, caller: McpCaller | undefined) => boolean
  readonly serverInfo: {readonly name: string; readonly version: string}
  /**
   * Told about every frame this host answered — what an agent asked for, and how it went.
   *
   * Optional and purely observational: the screen uses it to show that serving is *doing* something,
   * which "connected" cannot say. Never given the call's arguments (see `services/mcp/activity.ts`).
   */
  readonly onActivity?: (call: AgentCall) => void
  /** Where to dial. Built by the caller so this module never learns how a ticket is obtained. */
  readonly socketUrl: () => Promise<SocketUrlResult>
  /**
   * The session behind the socket is over, so this host has stopped.
   *
   * ⚠️ Reconnecting is the wrong answer to it: the ticket mint refuses an expired session identically
   * every time, so the backoff would run for ever while the screen said `Connecting…` and every agent
   * was told the wallet is not connected. Only signing in again produces a token that works.
   */
  readonly onSessionExpired?: () => void
  readonly makeSocket?: (url: string) => WebSocket
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  readonly random?: () => number
}

export type McpHost = {
  readonly stop: () => void
  /** Whether a socket is currently open — what the pairing screen shows as "reachable". */
  readonly isConnected: () => boolean
  readonly onStateChange: (listener: (connected: boolean) => void) => () => void
}

/** Full jitter, so many devices reconnecting after one outage do not arrive together. */
const reconnectDelayMs = (attempt: number, random: () => number): number =>
  Math.round(random() * Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)))

export const startMcpHost = (deps: McpHostDeps): McpHost => {
  const makeSocket = deps.makeSocket ?? ((url: string) => new WebSocket(url))
  const schedule = deps.setTimeoutImpl ?? setTimeout
  const random = deps.random ?? Math.random
  const listeners = new Set<(connected: boolean) => void>()

  let socket: WebSocket | undefined
  let attempt = 0
  let stopped = false
  let requestCounter = 0

  const setConnected = (connected: boolean) => {
    for (const listener of listeners) listener(connected)
  }

  const server = createMcpServer({
    resolverFor: deps.resolverFor,
    localFor: deps.localFor,
    serverInfo: deps.serverInfo,
    instructions: deps.instructions,
    // Fixed here, not taken from anything the agent sends. See {@link MCP_AGENT_ORIGIN}.
    session: {origin: MCP_AGENT_ORIGIN},
    nextRequestId: () => `mcp-${++requestCounter}`,
    ...(deps.toolVisible !== undefined ? {toolVisible: deps.toolVisible} : {}),
  })

  /**
   * How a reply reads to somebody watching.
   *
   * ⚠️ A tool **refusal** is not an error and must not be drawn as one: it is the wallet answering, and
   * the agent acting on the answer. Conflating the two makes a working surface look broken — a scope
   * refusal is the commonest thing an agent sees while it works out which wallet to use.
   */
  const outcomeOf = (reply: JsonRpcResponse | null, isNotification: boolean): AgentCallOutcome => {
    // ⚠️ **A notification has no reply, and that is success.** `handle` returns null for any frame with
    // no `id` on purpose — answering one is a protocol violation. Reading that null as a failure drew
    // `notifications/initialized` in red on the serving screen for every client that connects, which is
    // the handshake working exactly as designed. Caught by the activity meter on the day it shipped.
    if (isNotification) return 'ok'
    if (reply === null || reply.error !== undefined) return 'error'
    return (reply.result as {isError?: unknown} | undefined)?.isError === true ? 'refused' : 'ok'
  }

  const answer = async (raw: string): Promise<void> => {
    const envelope = parseEnvelope(raw)
    if (envelope === undefined) return
    const startedAt = Date.now()
    // ⚠️ Logged on every frame, including the unattributed case: "this relay does not attribute calls"
    // and "this agent is unknown to us" are the same shape on screen and different facts, and a
    // per-agent permission that silently applies to all of them is the defect this attribution exists
    // to prevent.
    logger.debug('mcp frame', {
      origin: ORIGIN,
      method: (envelope.frame as {method?: unknown} | null)?.method,
      pairingId: envelope.agent?.pairingId ?? null,
      agent: envelope.agent?.label ?? null,
    })
    let reply: JsonRpcResponse | null
    try {
      reply = await deps.runFrame(server.handle(envelope.frame as JsonRpcRequest, envelope.agent))
    } catch (error) {
      // A sentinel escaping here means the connector wanted UI that nothing is driving. Answer rather
      // than go silent: an agent left waiting cannot tell this apart from a hung wallet.
      //
      // ⚠️ The reason is carried into the message, not dropped. An agent shows this to a person, and
      // "could not complete that request" gives them nothing to do about it — the whole difference
      // between "no session granted" and "the wallet is broken" lives in this string.
      logger.warn('mcp frame failed', {origin: ORIGIN, error: String(error)})
      const reason = error instanceof Error && error.message !== '' ? error.message : String(error)
      reply = {
        jsonrpc: '2.0',
        id: (envelope.frame as {id?: string | number} | null)?.id ?? null,
        error: {code: -32603, message: `the wallet could not complete that request: ${reason}`},
      }
    }
    if (deps.onActivity !== undefined) {
      const frame = envelope.frame as {method?: unknown; params?: unknown; id?: unknown} | null
      const method = typeof frame?.method === 'string' ? frame.method : 'unknown'
      const tool = (frame?.params as {name?: unknown} | undefined)?.name
      deps.onActivity({
        at: Date.now(),
        method,
        ...(method === 'tools/call' && typeof tool === 'string' ? {tool} : {}),
        agent: envelope.agent?.label ?? null,
        outcome: outcomeOf(reply, frame?.id === undefined),
        ms: Date.now() - startedAt,
      })
    }
    // A notification produces no reply, and sending one back would be a protocol violation.
    if (reply === null) return
    try {
      socket?.send(JSON.stringify({relayId: envelope.relayId, frame: reply}))
    } catch (error) {
      logger.warn('mcp reply could not be sent', {origin: ORIGIN, error: String(error)})
    }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    attempt += 1
    const delay = reconnectDelayMs(attempt, random)
    logger.debug('mcp reconnecting', {origin: ORIGIN, attempt, delay})
    schedule(() => void connect(), delay)
  }

  const connect = async (): Promise<void> => {
    if (stopped) return
    const next = await deps.socketUrl()
    if (next.kind === 'expired') {
      logger.warn('mcp stopped: the session behind the socket has expired', {origin: ORIGIN})
      stopped = true
      setConnected(false)
      deps.onSessionExpired?.()
      return
    }
    if (next.kind === 'retry') {
      logger.debug('mcp has no socket url yet', {origin: ORIGIN})
      scheduleReconnect()
      return
    }
    if (stopped) return
    let ws: WebSocket
    try {
      ws = makeSocket(next.url)
    } catch (error) {
      logger.warn('mcp socket could not be created', {origin: ORIGIN, error: String(error)})
      scheduleReconnect()
      return
    }
    socket = ws
    ws.onopen = () => {
      attempt = 0
      logger.debug('mcp connected', {origin: ORIGIN})
      setConnected(true)
    }
    ws.onmessage = (message: {data?: unknown}) => {
      if (typeof message.data !== 'string') return
      void answer(message.data)
    }
    ws.onerror = () => {
      // Close owns the retry, so one failure does not schedule two reconnects.
      logger.debug('mcp socket error', {origin: ORIGIN})
    }
    ws.onclose = (event: {code?: number}) => {
      socket = undefined
      setConnected(false)
      logger.debug('mcp socket closed', {origin: ORIGIN, code: event.code ?? 1006})
      scheduleReconnect()
    }
  }

  void connect()

  return {
    stop: () => {
      stopped = true
      try {
        socket?.close()
      } catch (error) {
        logger.debug('mcp socket close threw', {origin: ORIGIN, error: String(error)})
      }
      socket = undefined
      setConnected(false)
    },
    isConnected: () => socket !== undefined,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
