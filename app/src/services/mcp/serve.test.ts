// The ordering IS the behaviour: the grant lands before the socket, and stopping revokes it. Both are
// invisible in the app (a missing grant looks like a refusing wallet, a surviving grant looks like
// nothing at all), so they are pinned here.
import type {ChainType, DappSession, SessionManager} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {type AgentCapabilities, DEFAULT_AGENT_CAPABILITIES, sharedOnly} from './agent-capabilities'
import {MCP_AGENT_ORIGIN} from './host'
import {MCP_SESSION_TTL_MS, type McpConnectorDeps, serveAgents} from './serve'
import type {SocketUrlResult} from './socket-url'

/** Both chains, one wallet+account — what the screen grants by default once a scope is picked. */
const CAPS: AgentCapabilities = {...DEFAULT_AGENT_CAPABILITIES, scopes: [{groupId: 'group-1', accountIndex: 3}]}

type Call = {
  readonly what: 'connect' | 'disconnect'
  readonly origin: string
  readonly chainType: ChainType
  readonly groupId?: string | undefined
  readonly accountIndex?: number | undefined
}

const session = (origin: string): DappSession => ({
  id: 'session-1',
  origin,
  chainType: 'cardano',
  groupId: 'group-1',
  accountIndex: 3,
  connectedAt: 0,
  expiresAt: MCP_SESSION_TTL_MS,
})

const managerSpy = (
  options: {connectFails?: boolean; connectFailsOn?: ChainType; existing?: readonly DappSession[]} = {},
) => {
  const calls: Call[] = []
  const manager = {
    // What is already granted. Reconciliation reads it to find grants the user no longer wants.
    sessions: Effect.succeed(options.existing ?? []),
    connect: (origin: string, chainType: ChainType) => {
      calls.push({what: 'connect', origin, chainType})
      const fails = options.connectFails === true || options.connectFailsOn === chainType
      return fails ? Effect.fail(new Error('store is gone') as never) : Effect.succeed(session(origin))
    },
    disconnect: (origin: string, chainType: ChainType, groupId?: string, accountIndex?: number) => {
      calls.push({what: 'disconnect', origin, chainType, ...(groupId === undefined ? {} : {groupId, accountIndex})})
      return Effect.void
    },
  } as unknown as SessionManager
  return {manager, calls}
}

const connectorFor = (manager: SessionManager): McpConnectorDeps => ({
  resolverFor: () =>
    ({resolve: () => Effect.succeed({id: 'x'}), isSupported: () => true, supportedMethods: () => []}) as never,
  localFor: () => async () => ({ok: true, value: null}),
  sessionManager: manager,
  // Nothing here runs a frame — the socket is faked — so this only has to satisfy the shape.
  runFrame: <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>),
})

describe('serveAgents', () => {
  it('grants the agent origin a session before it opens a socket', async () => {
    const {manager, calls} = managerSpy()
    const order: string[] = []
    const startHost = vi.fn(() => {
      order.push('socket')
      return {stop: () => {}, isConnected: () => true, onStateChange: () => () => {}}
    })
    await serveAgents({
      connector: connectorFor(manager),
      sessionToken: 'session-token',
      capabilities: sharedOnly(CAPS),
      scopeLabels: new Map([['group-1:3', 'Test wallet · Account 3']]),
      startHost: startHost as never,
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
    })
    // The grants are recorded before the host is ever constructed.
    expect(calls.map((c) => c.what)).toEqual(['connect', 'connect'])
    expect(order).toEqual(['socket'])
    for (const call of calls) expect(call.origin).toBe(MCP_AGENT_ORIGIN)
    // ⚠️ **Both chains.** The catalogue serves Cardano and Midnight tools, and a grant covering only
    // one means every tool on the other answers `not connected` — nine tools advertised in
    // `tools/list` that cannot work. Found by calling one through the relay, not by a test.
    expect(calls.map((c) => c.chainType)).toEqual(['cardano', 'midnight'])
  })

  // ⚠️ **Stopping closes the socket and revokes nothing.** Serving is the socket; a paired agent stays
  // authorised until the person revokes its pairing or takes its wallet out of scope. Revoking here
  // made a toggle silently undo a decision made deliberately somewhere else — and made an agent look
  // as though it had lost access every time somebody closed the screen.
  it('closes the socket when serving stops, and leaves the grants alone', async () => {
    const {manager, calls} = managerSpy()
    const stop = vi.fn()
    const serving = await serveAgents({
      connector: connectorFor(manager),
      sessionToken: 'session-token',
      capabilities: sharedOnly(CAPS),
      scopeLabels: new Map([['group-1:3', 'Test wallet · Account 3']]),
      startHost: (() => ({stop, isConnected: () => true, onStateChange: () => () => {}})) as never,
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
    })
    await serving.stop()
    expect(stop).toHaveBeenCalledOnce()
    expect(calls.map((c) => c.what)).toEqual(['connect', 'connect'])
    for (const call of calls) expect(call.origin).toBe(MCP_AGENT_ORIGIN)
  })

  // The other half of "the grant mirrors what the user granted": a chain switched off or a wallet taken
  // out of scope has to stop being reachable, and nothing else would ever remove it.
  it('revokes an agent session the user no longer grants, before the socket opens', async () => {
    const stale = {
      origin: MCP_AGENT_ORIGIN,
      chainType: 'cardano' as ChainType,
      groupId: 'group-gone',
      accountIndex: 0,
    } as DappSession
    const {manager, calls} = managerSpy({existing: [stale]})
    const order: string[] = []
    await serveAgents({
      connector: connectorFor(manager),
      sessionToken: 'session-token',
      capabilities: sharedOnly(CAPS),
      scopeLabels: new Map(),
      startHost: (() => {
        order.push('socket')
        return {stop: () => {}, isConnected: () => true, onStateChange: () => () => {}}
      }) as never,
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
    })
    const revoked = calls.filter((c) => c.what === 'disconnect')
    expect(revoked).toHaveLength(1)
    expect(revoked[0]?.groupId).toBe('group-gone')
    // Before the socket, so no frame can be answered against a grant the user has withdrawn.
    expect(order).toEqual(['socket'])
    expect(calls.findIndex((c) => c.what === 'disconnect')).toBe(0)
  })

  // ⚠️ Another origin's sessions are none of this module's business. Reconciling by scope alone would
  // sign every dApp out every time somebody served an agent.
  it('leaves other origins’ sessions untouched', async () => {
    const other = {
      origin: 'https://someone.example',
      chainType: 'cardano' as ChainType,
      groupId: 'group-gone',
      accountIndex: 0,
    } as DappSession
    const {manager, calls} = managerSpy({existing: [other]})
    await serveAgents({
      connector: connectorFor(manager),
      sessionToken: 'session-token',
      capabilities: sharedOnly(CAPS),
      scopeLabels: new Map(),
      startHost: (() => ({stop: () => {}, isConnected: () => true, onStateChange: () => () => {}})) as never,
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
    })
    expect(calls.filter((c) => c.what === 'disconnect')).toEqual([])
  })

  // ⚠️ A half-granted origin is worse than none: serving would start, the Cardano tools would work and
  // the Midnight half would answer `not connected` — the exact state granting both exists to remove,
  // arrived at by accident.
  it('rolls the first grant back when the second cannot be persisted', async () => {
    const {manager, calls} = managerSpy({connectFailsOn: 'midnight'})
    const startHost = vi.fn()
    await expect(
      serveAgents({
        connector: connectorFor(manager),
        sessionToken: 'session-token',
        capabilities: sharedOnly(CAPS),
        scopeLabels: new Map([['group-1:3', 'Test wallet · Account 3']]),
        startHost: startHost as never,
        socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
      }),
    ).rejects.toThrow()
    expect(startHost).not.toHaveBeenCalled()
    expect(calls.map((c) => `${c.what}:${c.chainType}`)).toEqual([
      'connect:cardano',
      'connect:midnight',
      'disconnect:cardano',
    ])
  })

  it('does not open a socket when the grant cannot be persisted', async () => {
    const {manager} = managerSpy({connectFails: true})
    const startHost = vi.fn()
    await expect(
      serveAgents({
        connector: connectorFor(manager),
        sessionToken: 'session-token',
        capabilities: sharedOnly(CAPS),
        scopeLabels: new Map([['group-1:3', 'Test wallet · Account 3']]),
        startHost: startHost as never,
        socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
      }),
    ).rejects.toThrow()
    // Serving with no grant answers every call "no session", which reads as a wallet that is present
    // and refusing — worse than not serving.
    expect(startHost).not.toHaveBeenCalled()
  })

  it('mints a fresh socket url from the session token on every dial', async () => {
    const {manager} = managerSpy()
    const socketUrl = vi.fn(() =>
      Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket?ticket=t'} as const),
    )
    let dial: (() => Promise<SocketUrlResult>) | undefined
    await serveAgents({
      connector: connectorFor(manager),
      sessionToken: 'session-token',
      capabilities: sharedOnly(CAPS),
      scopeLabels: new Map([['group-1:3', 'Test wallet · Account 3']]),
      startHost: ((deps: {socketUrl: () => Promise<SocketUrlResult>}) => {
        dial = deps.socketUrl
        return {stop: () => {}, isConnected: () => false, onStateChange: () => () => {}}
      }) as never,
      socketUrl,
    })
    await dial?.()
    await dial?.()
    // Two dials, two tickets: a 60-second ticket reused after an outage is refused, which looks like a
    // permission problem rather than the stale credential it is.
    expect(socketUrl).toHaveBeenCalledTimes(2)
    expect(socketUrl).toHaveBeenCalledWith('session-token')
  })
})
