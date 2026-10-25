/**
 * Turning agent serving on and off: grant the session, hold the socket, give both back.
 *
 * Kept out of React so the ordering is testable — and the ordering is the whole content of this module.
 * A socket opened before the grant lands would answer the agent's first `getBalance` with "no session",
 * and a stop that drops the socket without revoking the grant would leave an origin authorised with
 * nothing serving it.
 *
 * ⚠️ **Serving is the socket, not the grant** — and the earlier design had that backwards. A grant made
 * when serving started and revoked when it stopped meant every toggle churned the authorisation, so a
 * paired agent's access appeared to come and go with a button. It does not: a pairing is authorised
 * once, deliberately, and only a *revoke* takes it away.
 *
 * What actually gates an agent is that **nothing can reach the wallet while no socket is open**. The
 * app dials out; with serving off there is no transport, so a live grant authorises nothing. That is
 * what lets start and stop be free, and it is why the grant is made with no expiry.
 *
 * The grant set instead mirrors **what the user granted** — the chains and scopes in
 * {@link ServeOptions.capabilities} — and is reconciled here, at the one moment before any frame can be
 * answered: what is in scope is granted, and an agent-origin session for a chain or wallet no longer in
 * scope is revoked.
 *
 * ⚠️ **Both chains, because the catalogue serves both.** This granted Cardano alone while the catalogue
 * held one Cardano tool, and milestone 2 made that a real gap: every Midnight tool answered
 * `not connected` — nine tools advertised in `tools/list` that could not work, found by calling one
 * through the relay. A grant that covers less than the catalogue is the same defect as an entry point
 * declared sponsored that cannot be sponsored.
 *
 * @module
 */

import type {ChainType, DappSession, Resolver, SessionManager} from '@pnyx/dapp-connector'
import type {LocalToolRunner, McpCaller} from '@pnyx/mcp-server'
import {Effect} from 'effect'
import {logger} from '../../logger'
import type {AgentCall} from './activity'
import {
  type AgentCapabilityBook,
  anyGranted,
  capabilitiesForAgent,
  grantedChains,
  scopeKey,
  servingBlocker,
  toolAllowed,
} from './agent-capabilities'
import {MCP_AGENT_ORIGIN, startMcpHost} from './host'
import {AGENT_INSTRUCTIONS, scopeGuidance} from './instructions'
import {mcpSocketUrl, type SocketUrlResult} from './socket-url'

const ORIGIN = 'mcp-serve'

/**
 * The connector pieces serving needs, built by the app from the same `createResolver` the in-app
 * browser uses — an agent is gated by the connector's own rules, never by a second implementation of
 * them (`docs/MCP_DEV_TOOL_SPEC.md` §2).
 *
 * The group and account are here because a grant names them: a session for "whichever account is
 * selected" would expose a different one after a switch.
 */
export type McpConnectorDeps = {
  /**
   * The resolver for one granted scope, or a refusal naming the choices.
   *
   * ⚠️ Looked up per call rather than built once: an agent granted several wallets means several
   * connectors, and serving one of them under another's name is the failure this exists to prevent.
   */
  readonly resolverFor: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => Resolver | {readonly refusal: string}
  /**
   * The runner for the tools the app answers itself — the history read and the builders.
   *
   * ⚠️ Per scope for the same reason as the resolver: a builder plans against one wallet's UTxO set,
   * and building for the wallet the app happens to have selected is how an agent spends from a wallet
   * nobody named.
   */
  readonly localFor: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => LocalToolRunner | {readonly refusal: string}
  readonly sessionManager: SessionManager
  /** Runs one protocol frame in the host app's runtime. */
  readonly runFrame: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
}

/**
 * No expiry: the grant lasts until the user changes what is granted, or revokes the pairing.
 *
 * ⚠️ **A TTL here was a bug waiting for a long session.** It was an hour, which meant a wallet served
 * for longer than that started refusing its own agent mid-conversation, for a reason nothing on screen
 * could explain. It is not needed for safety either — the socket is the gate, and a grant with nobody
 * connected authorises nothing.
 */
export const MCP_SESSION_TTL_MS = null

/**
 * What an agent is told this server is. The version names the **tool surface**, not the app build: it
 * is what an agent would key its expectations on, and it changes when the catalogue does, which a build
 * number does not track.
 */
export const MCP_SERVER_INFO = {name: 'pnyx-wallet', version: '1'} as const

export type McpServing = {
  /** Stop serving: close the socket, then revoke the grant. */
  readonly stop: () => Promise<void>
  readonly isConnected: () => boolean
  readonly onStateChange: (listener: (connected: boolean) => void) => () => void
}

export type ServeOptions = {
  readonly connector: McpConnectorDeps
  /** The Pnyx session token — what a relay socket ticket is minted from. */
  readonly sessionToken: string
  /**
   * What the user has granted. Decides which chains are granted, across which accounts, and which
   * tools are advertised — the same values, so the three cannot disagree.
   */
  /**
   * What the wallet grants: a shared set plus per-agent overrides.
   *
   * ⚠️ The **union** decides which sessions to grant and whether serving can start at all, because one
   * socket serves every paired agent; the per-call gate is what keeps one agent inside its own grant.
   */
  readonly capabilities: AgentCapabilityBook
  /**
   * How to name each granted scope to a person, keyed the way an agent addresses it.
   *
   * Supplied by the caller because only a screen knows a wallet's name; this module must not reach for
   * the selected one.
   */
  readonly scopeLabels: ReadonlyMap<string, string>
  /**
   * The session behind the socket lapsed, so serving has stopped and only signing in again restarts it.
   *
   * Forwarded rather than handled here: this module cannot sign anybody in, and a hook that owns the
   * toggle can. Without it the host would retry an expired token for ever.
   */
  readonly onSessionExpired?: () => void
  /** Injected in tests. */
  readonly startHost?: typeof startMcpHost
  /** Told about every frame answered, for the screen's activity tail. See `./activity.ts`. */
  readonly onActivity?: (call: AgentCall) => void
  readonly socketUrl?: (sessionToken: string) => Promise<SocketUrlResult>
}

/**
 * Grant the agent origin a session and dial the relay.
 *
 * Throws if the grant cannot be persisted — serving without it would leave every call answered with
 * "no session", which reads to an agent as a wallet that is present but refusing.
 */
export const serveAgents = async (options: ServeOptions): Promise<McpServing> => {
  const {connector, sessionToken} = options
  const start = options.startHost ?? startMcpHost
  const url = options.socketUrl ?? mcpSocketUrl

  // ⚠️ Refused before the socket opens. Granting nothing and connecting anyway leaves an agent talking
  // to a wallet that refuses every call, which reads as broken rather than as a setting the user chose.
  const union = anyGranted(options.capabilities)
  const blocker = servingBlocker(union)
  if (blocker !== undefined) throw new Error(blocker)

  const chains = grantedChains(union)
  const scopes = union.scopes
  /**
   * Every (chain, wallet, account) the user granted — a session names all three, so this is the product.
   *
   * ⚠️ The wallet comes from the *scope*, not from the connector: the choice spans wallets, and taking
   * `connector.groupId` here would grant the selected wallet under another one's name.
   */
  const pairs = chains.flatMap((chainType) => scopes.map((scope) => ({chainType, ...scope})))

  const grant = (chainType: ChainType, groupId: string, accountIndex: number) =>
    connector.sessionManager.connect(MCP_AGENT_ORIGIN, chainType, groupId, accountIndex, MCP_SESSION_TTL_MS)
  const revoke = (chainType: ChainType, groupId: string, accountIndex: number) =>
    connector.sessionManager.disconnect(MCP_AGENT_ORIGIN, chainType, groupId, accountIndex)

  /**
   * Bring the agent origin's grants in line with what the user has granted.
   *
   * ⚠️ **Both directions.** Granting what is in scope is the obvious half; revoking what is *not* is
   * the half that matters — a chain switched off or a wallet taken out of scope has to stop being
   * reachable, and nothing else would ever remove it. Done before the socket opens, so no frame can be
   * answered against a stale grant.
   */
  const wanted = new Set(pairs.map((p) => `${p.chainType}:${p.groupId}:${p.accountIndex}`))
  const existing = await Effect.runPromise(
    Effect.orElseSucceed(connector.sessionManager.sessions, () => [] as readonly DappSession[]),
  )
  for (const session of existing) {
    if (session.origin !== MCP_AGENT_ORIGIN) continue
    const key = `${session.chainType}:${session.groupId}:${session.accountIndex}`
    if (wanted.has(key)) continue
    logger.debug('mcp revoking an agent session the user no longer grants', {origin: ORIGIN, key})
    await Effect.runPromise(Effect.ignore(revoke(session.chainType, session.groupId, session.accountIndex)))
  }

  const granted: {chainType: ChainType; groupId: string; accountIndex: number}[] = []
  try {
    for (const pair of pairs) {
      await Effect.runPromise(grant(pair.chainType, pair.groupId, pair.accountIndex))
      granted.push(pair)
    }
  } catch (error) {
    // ⚠️ Roll every grant this attempt made back. A partly-granted origin would start serving with some
    // tools working and the rest answering `not connected` — precisely the state granting explicitly
    // exists to remove, arrived at by accident.
    logger.warn('mcp could not grant every session; revoking the ones it made', {
      origin: ORIGIN,
      granted: granted.length,
      of: pairs.length,
      error: String(error),
    })
    for (const pair of granted)
      await Effect.runPromise(Effect.ignore(revoke(pair.chainType, pair.groupId, pair.accountIndex)))
    throw error
  }
  logger.debug('mcp reconciled the agent origin’s sessions', {
    origin: ORIGIN,
    agentOrigin: MCP_AGENT_ORIGIN,
    chains,
    scopes,
  })

  const host = start({
    resolverFor: connector.resolverFor,
    localFor: connector.localFor,
    runFrame: connector.runFrame,
    instructions:
      AGENT_INSTRUCTIONS +
      scopeGuidance(
        scopes.map((s) => ({key: scopeKey(s), label: options.scopeLabels.get(scopeKey(s)) ?? scopeKey(s)})),
      ),
    serverInfo: MCP_SERVER_INFO,
    socketUrl: () => url(sessionToken),
    ...(options.onSessionExpired === undefined ? {} : {onSessionExpired: options.onSessionExpired}),
    ...(options.onActivity === undefined ? {} : {onActivity: options.onActivity}),
    // Read per frame from the caller's current value, so turning a capability off takes effect on the
    // next `tools/list` rather than at the next reconnect.
    // ⚠️ Per caller, so an agent is never shown a tool its own grant would refuse — and read per frame
    // rather than captured, so turning a capability off takes effect on the next `tools/list` rather
    // than at the next reconnect.
    toolVisible: (name, caller) => toolAllowed(name, capabilitiesForAgent(options.capabilities, caller?.pairingId)),
  })

  return {
    isConnected: host.isConnected,
    onStateChange: host.onStateChange,
    /**
     * Close the socket. **Nothing is revoked.**
     *
     * ⚠️ Stopping is "stop answering", not "withdraw access" — a paired agent stays authorised until
     * the person revokes its pairing or takes its wallet out of scope. Revoking here made the two
     * indistinguishable and meant a toggle silently undid a decision the user had made deliberately
     * somewhere else.
     */
    stop: async () => {
      host.stop()
      logger.debug('mcp stopped serving; grants left in place', {origin: ORIGIN, granted: granted.length})
    },
  }
}
