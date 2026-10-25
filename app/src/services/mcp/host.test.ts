// The MCP host's frame loop, with a fake socket. What matters here is what a *relay* sees: a reply must
// carry the relay's own correlation id back, a notification must produce nothing at all, and a failure
// must still answer — an agent left waiting cannot tell silence apart from a hung wallet.
import type {Resolver} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {startMcpHost} from './host'
import type {SocketUrlResult} from './socket-url'

type FakeSocket = {
  sent: string[]
  onopen?: () => void
  onmessage?: (m: {data?: unknown}) => void
  onerror?: () => void
  onclose?: (e: {code?: number}) => void
  send: (raw: string) => void
  close: () => void
}

const makeFake = (): FakeSocket => {
  const socket: FakeSocket = {
    sent: [],
    send: (raw) => socket.sent.push(raw),
    close: () => socket.onclose?.({code: 1000}),
  }
  return socket
}

const resolver = (answer: (method: string) => unknown = () => ({lovelace: '1'})): Resolver => ({
  resolve: (message) => Effect.succeed({id: message.id, result: answer(message.method)}),
  isSupported: () => true,
  supportedMethods: () => [],
})

let fake: FakeSocket

const host = (deps: {resolver?: Resolver; runFrame?: McpRun} = {}) => {
  fake = makeFake()
  return startMcpHost({
    resolverFor: () => deps.resolver ?? resolver(),
    // No local tool is driven here; the host only has to hand one through.
    localFor: () => async () => ({ok: true, value: null}),
    runFrame: deps.runFrame ?? ((effect) => Promise.resolve(Effect.runSync(effect as never))),
    instructions: 'test instructions',
    serverInfo: {name: 'pnyx', version: 'test'},
    socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket'} as const),
    makeSocket: () => fake as unknown as WebSocket,
    setTimeoutImpl: () => 0,
    random: () => 0,
  })
}

type McpRun = Parameters<typeof startMcpHost>[0]['runFrame']

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the frame loop', () => {
  it('answers with the relay id it was given, not one of its own', async () => {
    const h = host()
    await flush()
    fake.onopen?.()
    fake.onmessage?.({data: JSON.stringify({relayId: 77, frame: {jsonrpc: '2.0', id: 'a', method: 'tools/list'}})})
    await flush()
    // Echoing the wrong relay id means the agent's request times out even though the wallet answered.
    expect(JSON.parse(fake.sent[0] ?? '{}')).toMatchObject({relayId: 77})
    h.stop()
  })

  // ⚠️ Regression. A notification is answered with no reply *by design*, and the activity meter mapped
  // that null to `error` — so `notifications/initialized` drew red on the serving screen for every
  // client handshake, i.e. the handshake working. Caught by the meter itself on the day it shipped.
  it('reports a notification as ok, not as a failure', async () => {
    const seen: {method: string; outcome: string}[] = []
    fake = makeFake()
    const h = startMcpHost({
      resolverFor: () => resolver(),
      localFor: () => async () => ({ok: true, value: null}),
      runFrame: (effect) => Promise.resolve(Effect.runSync(effect as never)),
      instructions: 'test instructions',
      serverInfo: {name: 'pnyx', version: 'test'},
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket'} as const),
      makeSocket: () => fake as unknown as WebSocket,
      setTimeoutImpl: () => 0,
      random: () => 0,
      onActivity: (call) => seen.push({method: call.method, outcome: call.outcome}),
    })
    await flush()
    fake.onopen?.()
    fake.onmessage?.({data: JSON.stringify({relayId: 1, frame: {jsonrpc: '2.0', method: 'notifications/initialized'}})})
    await flush()

    expect(seen).toEqual([{method: 'notifications/initialized', outcome: 'ok'}])
    h.stop()
  })

  it('still reports a real protocol error as an error', async () => {
    const seen: string[] = []
    fake = makeFake()
    const h = startMcpHost({
      resolverFor: () => resolver(),
      localFor: () => async () => ({ok: true, value: null}),
      runFrame: (effect) => Promise.resolve(Effect.runSync(effect as never)),
      instructions: 'test instructions',
      serverInfo: {name: 'pnyx', version: 'test'},
      socketUrl: () => Promise.resolve({kind: 'ready', url: 'wss://relay.test/mcp/socket'} as const),
      makeSocket: () => fake as unknown as WebSocket,
      setTimeoutImpl: () => 0,
      random: () => 0,
      onActivity: (call) => seen.push(call.outcome),
    })
    await flush()
    fake.onopen?.()
    // A method the server does not serve, *with* an id — so it is answered, and answered with an error.
    fake.onmessage?.({data: JSON.stringify({relayId: 1, frame: {jsonrpc: '2.0', id: 'x', method: 'server/discover'}})})
    await flush()

    expect(seen).toEqual(['error'])
    h.stop()
  })

  it('sends nothing for a notification', async () => {
    const h = host()
    await flush()
    fake.onopen?.()
    fake.onmessage?.({data: JSON.stringify({relayId: 1, frame: {jsonrpc: '2.0', method: 'notifications/initialized'}})})
    await flush()
    expect(fake.sent).toHaveLength(0)
    h.stop()
  })

  it('answers a tools/call through the connector', async () => {
    const h = host({resolver: resolver((method) => ({echoed: method}))})
    await flush()
    fake.onopen?.()
    fake.onmessage?.({
      data: JSON.stringify({
        relayId: 3,
        frame: {jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'cardano_getBalance'}},
      }),
    })
    await flush()
    const sent = JSON.parse(fake.sent[0] ?? '{}')
    expect(sent.relayId).toBe(3)
    expect(sent.frame.result.content[0].text).toContain('getBalance')
    h.stop()
  })

  it('still answers when the frame throws, rather than leaving the agent waiting', async () => {
    const h = host({runFrame: () => Promise.reject(new Error('needs approval UI'))})
    await flush()
    fake.onopen?.()
    fake.onmessage?.({
      data: JSON.stringify({
        relayId: 5,
        frame: {jsonrpc: '2.0', id: 'x', method: 'tools/call', params: {name: 'cardano_getBalance'}},
      }),
    })
    await flush()
    const sent = JSON.parse(fake.sent[0] ?? '{}')
    expect(sent.relayId).toBe(5)
    // Under the agent's id, so its client can match the failure to its request.
    expect(sent.frame).toMatchObject({id: 'x', error: {code: -32603}})
    // ⚠️ And carrying the reason. An agent shows this to a person: "could not complete that request"
    // gives them nothing to do, while the actual reason is the difference between "grant a session" and
    // "the wallet is broken".
    expect(sent.frame.error.message).toContain('needs approval UI')
    h.stop()
  })

  it('drops a frame with no relay id instead of guessing one', async () => {
    const h = host()
    await flush()
    fake.onopen?.()
    fake.onmessage?.({data: JSON.stringify({frame: {jsonrpc: '2.0', id: 1, method: 'tools/list'}})})
    fake.onmessage?.({data: 'not json'})
    await flush()
    expect(fake.sent).toHaveLength(0)
    h.stop()
  })
})

describe('connection state', () => {
  it('reports connected only while a socket is open', async () => {
    const seen: boolean[] = []
    const h = host()
    h.onStateChange((c) => seen.push(c))
    await flush()
    fake.onopen?.()
    expect(h.isConnected()).toBe(true)
    fake.onclose?.({code: 1006})
    // A backgrounded or closed app serves nothing, and the screen has to be able to say so.
    expect(h.isConnected()).toBe(false)
    expect(seen).toEqual([true, false])
    h.stop()
  })
})

describe('agent attribution on the envelope', () => {
  const attributed = (agent: unknown) =>
    JSON.stringify({relayId: 5, frame: {jsonrpc: '2.0', id: 'a', method: 'tools/list'}, agent})

  it('answers an attributed frame exactly as it answers an unattributed one', async () => {
    const h = host()
    await flush()
    fake.onopen?.()
    fake.onmessage?.({data: attributed({pairingId: 'p1', label: 'Claude Code'})})
    await flush()
    expect(JSON.parse(fake.sent[0] ?? '{}')).toMatchObject({relayId: 5})
    h.stop()
  })

  it('still answers when the attribution is malformed — a bad field must not drop the call', async () => {
    // The relay is a different deployment on its own release cycle. A wallet that stopped serving over
    // an unrecognised `agent` would be taken down by somebody else's rollout.
    for (const bad of [null, 'p1', 42, {}, {pairingId: ''}, {pairingId: 7}]) {
      const h = host()
      await flush()
      fake.onopen?.()
      fake.onmessage?.({data: attributed(bad)})
      await flush()
      expect(JSON.parse(fake.sent[0] ?? '{}')).toMatchObject({relayId: 5})
      h.stop()
    }
  })

  it('drops a frame with no relay id whatever its attribution says', async () => {
    // Attribution is not a substitute for the correlation id: a reply with no relayId is unroutable.
    const h = host()
    await flush()
    fake.onopen?.()
    fake.onmessage?.({
      data: JSON.stringify({
        frame: {jsonrpc: '2.0', id: 1, method: 'tools/list'},
        agent: {pairingId: 'p1', label: 'x'},
      }),
    })
    await flush()
    expect(fake.sent).toHaveLength(0)
    h.stop()
  })
})

describe('an expired session', () => {
  const hostWith = (socketUrl: () => Promise<SocketUrlResult>, onSessionExpired: () => void) => {
    fake = makeFake()
    const scheduled: (() => void)[] = []
    const h = startMcpHost({
      resolverFor: () => resolver(),
      localFor: () => async () => ({ok: true, value: null}),
      runFrame: (effect) => Promise.resolve(Effect.runSync(effect as never)),
      instructions: 'test instructions',
      serverInfo: {name: 'pnyx', version: 'test'},
      socketUrl,
      onSessionExpired,
      makeSocket: () => fake as unknown as WebSocket,
      setTimeoutImpl: (fn) => {
        scheduled.push(fn)
        return 0
      },
      random: () => 0,
    })
    return {h, scheduled}
  }

  // The defect: `expired` used to be indistinguishable from "not now", so the host backed off and
  // dialled again with the same dead token, for ever. The screen said `Connecting…` and every agent was
  // told the wallet is not connected, which sent the reader to the device where nothing was wrong.
  it('stops rather than retrying a token that can never work', async () => {
    const socketUrl = vi.fn(async (): Promise<SocketUrlResult> => ({kind: 'expired'}))
    const expired = vi.fn()
    const {h, scheduled} = hostWith(socketUrl, expired)
    await flush()
    expect(expired).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(0)
    expect(socketUrl).toHaveBeenCalledTimes(1)
    expect(h.isConnected()).toBe(false)
    h.stop()
  })

  it('still retries a refusal that another attempt may not hit', async () => {
    const socketUrl = vi.fn(async (): Promise<SocketUrlResult> => ({kind: 'retry'}))
    const expired = vi.fn()
    const {h, scheduled} = hostWith(socketUrl, expired)
    await flush()
    expect(expired).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    h.stop()
  })
})
