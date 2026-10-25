// The protocol layer, driven with a stub resolver so every path is reachable without a transport.
//
// Three behaviours here are easy to get subtly wrong and expensive to notice later: a notification must
// produce NO reply, a wallet refusal must reach the model as an `isError` result rather than a JSON-RPC
// error, and the session must come from config rather than from the frame.
import type {DappMessage, Resolver, WalletResponse} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {TOOLS} from './catalogue.js'
import {createMcpServer, type LocalToolRunner} from './protocol.js'
import {JsonRpcErrorCode, type JsonRpcRequest, type JsonRpcResponse, PREFERRED_PROTOCOL_VERSION} from './types.js'

const seen: DappMessage[] = []

const resolverThat = (answer: (m: DappMessage) => WalletResponse): Resolver => ({
  resolve: (message) =>
    Effect.sync(() => {
      seen.push(message)
      return answer(message)
    }),
  isSupported: () => true,
  supportedMethods: () => [],
})

const server = (answer: (m: DappMessage) => WalletResponse = (m) => ({id: m.id, result: {lovelace: '42'}})) => {
  seen.length = 0
  let n = 0
  return createMcpServer({
    resolverFor: () => resolverThat(answer),
    serverInfo: {name: 'pnyx', version: '0.1.0'},
    session: {origin: 'mcp://claude-code', sessionId: 'session-1'},
    instructions: 'the wallet can read the chain for you',
    nextRequestId: () => `req-${++n}`,
  })
}

// The stub resolver never fails, so the error channel is discharged here rather than in every test.
// Casting the *success* type away (as an earlier version did) turned every assertion below into a
// `never` access and hid four real type errors.
const run = (frame: JsonRpcRequest, s = server()): JsonRpcResponse | null =>
  Effect.runSync(s.handle(frame) as Effect.Effect<JsonRpcResponse | null>)

describe('initialize', () => {
  it('echoes a protocol revision it knows, so an older client keeps working', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26'}})
    expect((res?.result as {protocolVersion: string}).protocolVersion).toBe('2025-03-26')
  })

  it('answers with its own revision when the client asks for one it does not know', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '1999-01-01'}})
    expect((res?.result as {protocolVersion: string}).protocolVersion).toBe(PREFERRED_PROTOCOL_VERSION)
  })

  it('carries the instructions verbatim, which is the only always-loaded channel', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'initialize'})
    // Verbatim matters: this is where the CIP-139 prohibition lives, and an agent does not search for a
    // rule it does not know exists.
    expect((res?.result as {instructions: string}).instructions).toBe('the wallet can read the chain for you')
  })

  it('claims only the capabilities it implements', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'initialize'})
    // Claiming a capability and then erroring on its method is worse than not claiming it. Both of
    // these are served, and the `resources` suite below reads one to prove it.
    expect((res?.result as {capabilities: object}).capabilities).toEqual({tools: {}, resources: {}})
  })
})

describe('notifications produce no reply', () => {
  // Answering a notification is a protocol violation the client may drop the connection over.
  it.each([
    'notifications/initialized',
    'notifications/cancelled',
    'ping',
    'tools/list',
    'anything/else',
  ])('%s with no id returns null', (method) => {
    expect(run({jsonrpc: '2.0', method})).toBeNull()
  })

  it('does not run a tool call that has no id, because there is nowhere to report the outcome', () => {
    const s = server()
    expect(run({jsonrpc: '2.0', method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)).toBeNull()
    expect(seen).toHaveLength(0)
  })
})

describe('tools/list', () => {
  it('lists the catalogue', () => {
    const res = run({jsonrpc: '2.0', id: 2, method: 'tools/list'})
    const tools = (res?.result as {tools: {name: string}[]}).tools
    expect(tools.map((t) => t.name)).toContain('cardano_getBalance')
  })

  // Milestone 2 is the rest of the reads, so the catalogue is no longer one entry. Asserted against
  // `TOOLS` rather than a number, which would be a count somebody has to remember to bump.
  it('serves the whole catalogue, both chains', () => {
    const res = run({jsonrpc: '2.0', id: 30, method: 'tools/list'})
    const names = (res?.result as {tools: {name: string}[]}).tools.map((t) => t.name)
    expect(names).toEqual(TOOLS.map((t) => t.descriptor.name))
    expect(names).toContain('cardano_cip139_getAllPools')
    expect(names).toContain('midnight_getDustBalance')
    // Milestone 3: the Cardano write path is served, and it routes to the canonical review screen.
    expect(names).toContain('cardano_signTx')
    expect(names).toContain('cardano_submitTx')
    // Milestone 3, the Midnight half: the two builders route to their review screens, and submitting
    // relays what they returned.
    expect(names).toContain('midnight_makeTransfer')
    expect(names).toContain('midnight_balanceUnsealedTransaction')
    expect(names).toContain('midnight_submitTransaction')
    // Still absent: approvals that live in a browser-rendered *sheet* rather than a route, and methods
    // that can only ever refuse.
    expect(names).not.toContain('cardano_enable')
    expect(names).not.toContain('midnight_signData')
    expect(names).not.toContain('midnight_balanceSealedTransaction')
  })
})

describe('tools/call', () => {
  it('forwards to the connector method and returns its result', () => {
    const s = server()
    const res = run({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({chainType: 'cardano', method: 'getBalance'})
    expect(res?.result).toEqual({content: [{type: 'text', text: '{"lovelace":"42"}'}]})
  })

  it('takes the origin and session from config, never from the frame', () => {
    const s = server()
    run({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    expect(seen[0]?.origin).toBe('mcp://claude-code')
    expect(seen[0]?.sessionId).toBe('session-1')
  })

  // An agent trying to name its own origin used to have it silently stripped, which was safe but told
  // the agent nothing. It is now refused outright, and refused *before* the connector is reached — so
  // this covers the same property one step earlier, and `seen` staying empty is the assertion.
  it('refuses an argument the tool never declared, and calls nothing', () => {
    const s = server()
    const res = run(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {name: 'cardano_getBalance', arguments: {origin: 'https://evil.example', sessionId: 'other'}},
      },
      s,
    )
    expect(seen).toHaveLength(0)
    const result = res?.result as {isError?: boolean; content?: readonly {readonly text?: string}[]}
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('does not take `origin`')
  })

  it('surfaces a wallet refusal as an isError result the model can act on', () => {
    const s = server((m) => ({id: m.id, error: {code: -3, message: 'wallet is locked'}}))
    const res = run({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    // Not a JSON-RPC error: an agent that never sees the reason cannot ask the user to unlock.
    expect(res?.error).toBeUndefined()
    expect(res?.result).toEqual({content: [{type: 'text', text: 'wallet is locked'}], isError: true})
  })

  // ⚠️ End to end for the shaping, because the unit test on `paramsFor` cannot see what actually
  // reaches the connector. A nullary Midnight read receiving `{}` fails with "takes no parameters".
  it('sends no params for a nullary tool, whatever the client puts in arguments', () => {
    const s = server()
    run({jsonrpc: '2.0', id: 20, method: 'tools/call', params: {name: 'midnight_getDustBalance'}}, s)
    expect(seen[0]?.params).toBeUndefined()
    run({jsonrpc: '2.0', id: 21, method: 'tools/call', params: {name: 'midnight_getDustBalance', arguments: {}}}, s)
    expect(seen[1]?.params).toBeUndefined()
  })

  it('sends a positional array where the handler destructures one', () => {
    const s = server()
    run(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {name: 'midnight_getTxHistory', arguments: {pageNumber: 3, pageSize: 10}},
      },
      s,
    )
    expect(seen[0]?.params).toEqual([3, 10])
  })

  it('sends the arguments object where the handler reads one', () => {
    const s = server()
    run(
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {name: 'cardano_cip139_getPoolById', arguments: {value: 'pool1abc'}},
      },
      s,
    )
    expect(seen[0]?.params).toEqual({value: 'pool1abc'})
  })

  it('refuses an unknown tool as a protocol error, since there is nothing for a model to act on', () => {
    const res = run({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'cardano_drainWallet'}})
    expect(res?.error?.code).toBe(JsonRpcErrorCode.MethodNotFound)
  })

  it('rejects malformed params by name', () => {
    expect(run({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {}})?.error?.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    )
    expect(run({jsonrpc: '2.0', id: 8, method: 'tools/call', params: 'nope'})?.error?.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    )
  })

  it('serialises bigint results, which JSON.stringify would otherwise throw on', () => {
    const s = server((m) => ({id: m.id, result: {lovelace: 42n}}))
    const res = run({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    expect(res?.result).toEqual({content: [{type: 'text', text: '{"lovelace":"42"}'}]})
  })
})

describe('framing', () => {
  it('refuses a frame that is not JSON-RPC 2.0', () => {
    const res = run({jsonrpc: '1.0' as '2.0', id: 10, method: 'tools/list'})
    expect(res?.error?.code).toBe(JsonRpcErrorCode.InvalidRequest)
  })

  // `resources/list` was the example here until it became a method this server serves. Prompts are a
  // real MCP method this server does *not* implement, which is what makes it the honest example.
  it('answers an unsupported method with MethodNotFound', () => {
    expect(run({jsonrpc: '2.0', id: 11, method: 'prompts/list'})?.error?.code).toBe(JsonRpcErrorCode.MethodNotFound)
  })
})

describe('scope routing', () => {
  // ⚠️ The reason `resolverFor` is a function. An agent granted several wallets names one per call; a
  // single resolver would serve whichever the app happened to have selected.
  it('asks for the resolver of the scope the call named', () => {
    const asked: (string | undefined)[] = []
    const s = createMcpServer({
      resolverFor: (scope) => {
        asked.push(scope)
        return resolverThat((m) => ({id: m.id, result: 'ok'}))
      },
      serverInfo: {name: 'pnyx', version: '0.1.0'},
      session: {origin: 'mcp://agent'},
      instructions: '',
      nextRequestId: () => 'req-1',
    })
    run({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    run(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {name: 'cardano_getBalance', arguments: {scope: 'g2:1'}},
      },
      s,
    )
    expect(asked).toEqual([undefined, 'g2:1'])
  })

  // A refusal the *model* reads and acts on, not a protocol error it just reports.
  it('answers a refused scope as a tool error the model can act on', () => {
    const s = createMcpServer({
      resolverFor: () => ({refusal: "scope 'g9:0' is not granted"}),
      serverInfo: {name: 'pnyx', version: '0.1.0'},
      session: {origin: 'mcp://agent'},
      instructions: '',
      nextRequestId: () => 'req-1',
    })
    const res = run({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'cardano_getBalance'}}, s)
    expect(res?.error).toBeUndefined()
    expect(res?.result).toEqual({content: [{type: 'text', text: "scope 'g9:0' is not granted"}], isError: true})
  })
})

// The second dispatch kind: tools the app answers itself. The connector is not involved at all, which
// is the point — CIP-30 never builds anything, so a builder cannot be a connector method.
describe('local tools', () => {
  const localServer = (runner: LocalToolRunner | {readonly refusal: string}, withRunner = true) => {
    seen.length = 0
    let n = 0
    return createMcpServer({
      resolverFor: () => resolverThat((m) => ({id: m.id, result: null})),
      ...(withRunner ? {localFor: () => runner} : {}),
      serverInfo: {name: 'pnyx', version: '0.1.0'},
      session: {origin: 'mcp://claude-code'},
      instructions: '',
      nextRequestId: () => `req-${++n}`,
    })
  }

  const call = (args: Record<string, unknown>, s: ReturnType<typeof localServer>) =>
    Effect.runPromise(
      s.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {name: 'cardano_listHistory', arguments: args},
      }) as Effect.Effect<JsonRpcResponse | null>,
    )

  it('routes the call to the runner without touching the connector', async () => {
    const calls: {name: string; args: Record<string, unknown>}[] = []
    const s = localServer(async (c) => {
      calls.push(c)
      return {ok: true, value: [{hash: 'ab'}]}
    })
    const res = await call({limit: 10, scope: 'g1:0'}, s)
    // ⚠️ The scope is resolved into *which wallet answers*, and must not reach the tool as an argument.
    expect(calls).toEqual([{name: 'cardano_listHistory', args: {limit: 10}}])
    expect(seen).toEqual([])
    expect(res?.result).toEqual({content: [{type: 'text', text: '[{"hash":"ab"}]'}]})
  })

  // A builder that cannot build has a reason the model has to act on — not enough ADA, too many
  // outputs — so it is an `isError` result carrying that reason, never a JSON-RPC error.
  it('turns a refused run into an isError result the model can read', async () => {
    const s = localServer(async () => ({ok: false, message: 'not enough ADA: 12.4 short'}))
    expect((await call({}, s))?.result).toEqual({
      content: [{type: 'text', text: 'not enough ADA: 12.4 short'}],
      isError: true,
    })
  })

  // ⚠️ These runners reach into the app — a rail, a store, a screen. A rejection escaping here would
  // reach the agent as "An error has occurred", which is the one message a model can do nothing with.
  it('carries the reason through when the runner rejects', async () => {
    const s = localServer(async () => {
      throw new Error('the rail is not open')
    })
    const result = (await call({}, s))?.result as {content: {text: string}[]; isError: boolean}
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('the rail is not open')
    expect(result.content[0]?.text).toContain('cardano_listHistory')
  })

  it('refuses by name when the scope is not granted', async () => {
    const s = localServer({refusal: "scope 'g9:0' is not granted"})
    expect((await call({scope: 'g9:0'}, s))?.result).toEqual({
      content: [{type: 'text', text: "scope 'g9:0' is not granted"}],
      isError: true,
    })
  })

  // A host that serves only the connector surface answers with a fact the model can act on, rather than
  // a protocol error that reads as a broken wallet.
  it('says so when the host serves no local tools at all', async () => {
    const s = localServer(async () => ({ok: true, value: null}), false)
    const result = (await call({}, s))?.result as {content: {text: string}[]; isError: boolean}
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('cardano_listHistory')
  })
})

// The third channel: read on demand, so it costs an agent nothing until it decides it needs one.
describe('resources', () => {
  const read = (params: unknown) => run({jsonrpc: '2.0', id: 1, method: 'resources/read', params} as JsonRpcRequest)

  it('lists what can be read, without the text', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'resources/list'})
    const {resources} = res?.result as {resources: {uri: string; description: string}[]}
    expect(resources.length).toBeGreaterThan(0)
    for (const entry of resources) expect(entry).not.toHaveProperty('text')
  })

  it('reads one document by uri', () => {
    const res = read({uri: 'pnyx://guide/building'})
    const {contents} = res?.result as {contents: {uri: string; text: string}[]}
    expect(contents[0]?.uri).toBe('pnyx://guide/building')
    expect(contents[0]?.text).toContain('lovelace')
  })

  // ⚠️ Claiming `resources` in `initialize` and erroring on the methods would be worse than not
  // claiming it: a client that trusts the capability would show the user a channel that does not work.
  it('claims the capability it now actually serves', () => {
    const res = run({jsonrpc: '2.0', id: 1, method: 'initialize'})
    expect((res?.result as {capabilities: object}).capabilities).toEqual({tools: {}, resources: {}})
  })

  it('refuses a uri that is not in the list it gave', () => {
    expect(read({uri: 'pnyx://guide/nothing'})?.error?.code).toBe(JsonRpcErrorCode.InvalidParams)
    expect(read({})?.error?.code).toBe(JsonRpcErrorCode.InvalidParams)
  })
})

describe('per-caller gating', () => {
  const callerA = {pairingId: 'pair-a', label: 'Agent A'}
  const callerB = {pairingId: 'pair-b', label: 'Agent B'}

  const perCaller = () =>
    createMcpServer({
      // Only A may reach anything; B is refused by name.
      resolverFor: (_scope, caller) =>
        caller?.pairingId === 'pair-a'
          ? resolverThat((m) => ({id: m.id, result: {lovelace: '1'}}))
          : {refusal: 'not granted to this agent'},
      serverInfo: {name: 'pnyx', version: '0.1.0'},
      session: {origin: 'mcp://agent', sessionId: 's'},
      instructions: '',
      nextRequestId: () => 'req-1',
      // A sees one tool, B sees none.
      toolVisible: (name, caller) => caller?.pairingId === 'pair-a' && name === 'cardano_getNetworkId',
    })

  const call = (frame: JsonRpcRequest, caller?: {pairingId: string; label: string}) =>
    Effect.runSync(perCaller().handle(frame, caller) as Effect.Effect<JsonRpcResponse | null>)

  it('advertises a different catalogue to each agent', () => {
    const a = call({jsonrpc: '2.0', id: 1, method: 'tools/list'}, callerA)
    const b = call({jsonrpc: '2.0', id: 1, method: 'tools/list'}, callerB)
    expect((a?.result as {tools: unknown[]}).tools).toHaveLength(1)
    expect((b?.result as {tools: unknown[]}).tools).toHaveLength(0)
  })

  it('refuses a call from the agent that may not make it — the gate, not the listing', () => {
    // A client can name any tool without listing first, so hiding it is presentation and this is control.
    const res = call({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'cardano_getNetworkId'}}, callerB)
    expect(JSON.stringify(res?.result)).toContain('not granted to this agent')
  })

  it('answers the agent that may', () => {
    const res = call({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'cardano_getNetworkId'}}, callerA)
    expect(JSON.stringify(res?.result)).toContain('lovelace')
  })

  it('an unattributed call reaches the lookup as undefined rather than as some agent', () => {
    // The transport could not say who is calling; the wallet must be able to tell that apart from a
    // known agent instead of being handed a placeholder that matches somebody.
    const res = call({jsonrpc: '2.0', id: 4, method: 'tools/list'})
    expect((res?.result as {tools: unknown[]}).tools).toHaveLength(0)
  })
})
