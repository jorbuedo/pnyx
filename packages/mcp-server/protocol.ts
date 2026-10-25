/**
 * The MCP protocol layer: one JSON-RPC frame in, at most one frame out.
 *
 * **Transport-agnostic on purpose.** This module never learns whether it is behind a relay, a local
 * socket or a test harness — it takes a frame and returns a frame. That is the decision
 * `docs/MCP_DEV_TOOL_SPEC.md` §4.4 says has to be right today, because it costs nothing now and is
 * expensive to retrofit; it is also what makes every path here testable without a transport at all.
 *
 * **The tool surface is the connector's.** A `tools/call` becomes a `DappMessage` and goes through the
 * same `resolve` the in-app browser uses, so gating, session checks and approval sentinels are the
 * connector's behaviour rather than a second implementation of it.
 *
 * @module
 */

import type {DappMessage, Resolver, SentinelError, WalletResponse} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {
  effectiveScope,
  findTool,
  isConnectorTool,
  localArgs,
  paramsFor,
  SCOPE_ARGUMENT,
  toolDescriptors,
} from './catalogue.js'
import {findResource, resourceDescriptors} from './resources.js'
import {
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
  PREFERRED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ToolResult,
} from './types.js'
import {unknownArgRefusal} from './unknown-args.js'

export type ServerInfo = {
  readonly name: string
  readonly version: string
}

/**
 * What a local tool answered with.
 *
 * A result, not an exception, on both paths: a builder that cannot build has a *reason* — not enough
 * ADA, a recipient on the wrong network, too many outputs for one transaction — and the model is the
 * one that has to act on it. Throwing would flatten every one of those into "the wallet could not
 * complete that request".
 */
export type LocalToolOutcome =
  | {readonly ok: true; readonly value: unknown}
  /** Read by the agent and shown to a person, so it says what to change rather than that it failed. */
  | {readonly ok: false; readonly message: string}

/** Answers the tools the app serves itself — the transaction cache and the builders. */
export type LocalToolRunner = (call: {
  readonly name: string
  readonly args: Record<string, unknown>
}) => Promise<LocalToolOutcome>

/**
 * Which paired agent a frame came from, when the transport can say.
 *
 * ⚠️ **Threaded per frame rather than captured at construction, because one server serves them all.**
 * The relay gives every agent an identity paired one socket and one origin, so a server built around
 * one agent's permissions would apply them to every other agent on the same wallet. `undefined` is a
 * real state — a transport that cannot attribute a call — and must stay distinguishable from a known
 * agent rather than collapsing into a default.
 */
export type McpCaller = {
  readonly pairingId: string
  readonly label: string
}

export type McpServerConfig = {
  /**
   * The resolver to use, chosen per call by the scope it named.
   *
   * ⚠️ **A function, not a value.** An agent may be granted several wallets and each has its own
   * connector; a single resolver would serve whichever wallet the app happened to have selected. It
   * answers with a message instead when the scope is missing or not granted, because that is a fact the
   * *model* has to see — an agent that cannot tell "wrong wallet" from "wallet broken" retries for ever.
   */
  readonly resolverFor: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => Resolver | {readonly refusal: string}
  /**
   * The runner for tools the app answers itself, chosen by the scope a call named — same rule, same
   * refusal, as {@link McpServerConfig.resolverFor}.
   *
   * Optional so a host that serves only the connector surface (a test, an older build) needs no stub;
   * a local tool then answers with a refusal naming itself rather than a protocol error, because "this
   * wallet does not serve that" is a fact the model can act on.
   */
  readonly localFor?: (
    scope: string | undefined,
    caller: McpCaller | undefined,
  ) => LocalToolRunner | {readonly refusal: string}
  readonly serverInfo: ServerInfo
  /**
   * The session this connection speaks for. **Not supplied by the agent** — the agent authenticates
   * with a token and the transport resolves it to a session, so an agent cannot name an origin or a
   * wallet it was not granted (spec §3.4, §4.5).
   */
  readonly session: {readonly origin: string; readonly sessionId?: string}
  /**
   * Always-loaded guidance returned from `initialize`. The one place a prohibition can live: an agent
   * does not search for a rule it does not know exists (spec §3.3).
   */
  readonly instructions: string
  /** Monotonic-ish id source for the `DappMessage` correlation id. */
  readonly nextRequestId: () => string
  /**
   * Which tools this connection may see, by name.
   *
   * ⚠️ **Presentation, not a control.** A client can call any tool by name without listing first, so
   * the gate is the connector's own session check plus the host's capability refusal. Filtering here
   * stops an agent being shown something it cannot use — a tool advertised and then refused is the
   * defect class this whole surface is built to avoid. Omit to serve everything.
   */
  readonly toolVisible?: (name: string, caller: McpCaller | undefined) => boolean
}

const ok = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
})

const fail = (id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: {code, message, ...(data !== undefined ? {data} : {})},
})

/** A tool failure the *model* should see and can act on, not a protocol error. */
const toolError = (message: string): ToolResult => ({
  content: [{type: 'text', text: message}],
  isError: true,
})

const toolOk = (value: unknown): ToolResult => ({
  content: [{type: 'text', text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}],
})

/**
 * Negotiate the protocol revision.
 *
 * Echo the client's request when we know it, so a client on an older revision keeps working; answer with
 * ours when we do not, which is what the spec asks for and lets the client decide whether to continue.
 */
const negotiate = (requested: unknown): string =>
  typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PREFERRED_PROTOCOL_VERSION

export type McpServer = {
  /**
   * Handle one frame. Resolves to `null` for a notification — which has no `id` and must produce no
   * reply, because answering one is a protocol violation the client is entitled to drop the connection
   * over.
   */
  readonly handle: (frame: JsonRpcRequest, caller?: McpCaller) => Effect.Effect<JsonRpcResponse | null, SentinelError>
}

export const createMcpServer = (config: McpServerConfig): McpServer => {
  /**
   * Run a tool the app answers itself.
   *
   * ⚠️ **A rejection becomes a tool error, never a defect.** These runners reach into the app — a rail,
   * a store, a review screen — and anything that throws there would otherwise escape `Effect.tryPromise`
   * as a `FiberFailure` and reach the agent as "An error has occurred", which is the one message a
   * model can do nothing with. The reason is carried through instead, exactly as the connector path
   * carries a wire error's.
   */
  const runLocal = (
    id: JsonRpcRequest['id'],
    name: string,
    scope: string | undefined,
    args: unknown,
    caller: McpCaller | undefined,
  ): Effect.Effect<JsonRpcResponse, SentinelError> => {
    const chosenLocal = config.localFor?.(scope, caller)
    if (chosenLocal === undefined) return Effect.succeed(ok(id, toolError(`this wallet does not serve ${name}`)))
    if ('refusal' in chosenLocal) return Effect.succeed(ok(id, toolError(chosenLocal.refusal)))
    return Effect.tryPromise({
      try: () => chosenLocal({name, args: localArgs(args)}),
      // ⚠️ Mapped here, not read off the caught value later: the bare `Effect.tryPromise` wraps a
      // rejection in an `UnknownException` whose own message is "An unknown error occurred", and the
      // reason survives only inside its cause. That is the same shape that has already cost this repo a
      // debugging session — the model would be told a builder failed and nothing about why.
      catch: (error) => (error instanceof Error && error.message !== '' ? error.message : String(error)),
    }).pipe(
      Effect.map((outcome) => ok(id, outcome.ok ? toolOk(outcome.value) : toolError(outcome.message))),
      Effect.catchAll((reason: string) => Effect.succeed(ok(id, toolError(`${name} failed: ${reason}`)))),
    )
  }

  const callTool = (
    id: JsonRpcRequest['id'],
    params: unknown,
    caller: McpCaller | undefined,
  ): Effect.Effect<JsonRpcResponse, SentinelError> => {
    if (typeof params !== 'object' || params === null) {
      return Effect.succeed(fail(id, JsonRpcErrorCode.InvalidParams, 'tools/call needs an object with a name'))
    }
    const {name, arguments: args} = params as {name?: unknown; arguments?: unknown}
    if (typeof name !== 'string') {
      return Effect.succeed(fail(id, JsonRpcErrorCode.InvalidParams, 'tools/call needs a string name'))
    }
    const tool = findTool(name)
    // An unknown tool is a protocol error, not a tool error: the agent asked for something that is not
    // in the catalogue it was given, so there is nothing for a model to act on.
    if (tool === undefined) {
      return Effect.succeed(fail(id, JsonRpcErrorCode.MethodNotFound, `no such tool: ${name}`))
    }
    // An argument the tool never declared is refused here rather than ignored downstream — see
    // `unknown-args.ts` for the co-funded send that went to chain without the memo it was given. A tool
    // result rather than a protocol error, because the fix is the model's to make.
    const unknown = unknownArgRefusal(name, tool.descriptor.inputSchema, localArgs(args), SCOPE_ARGUMENT)
    if (unknown !== undefined) {
      return Effect.succeed(ok(id, toolError(unknown)))
    }
    // For a tool whose arguments already name every wallet it uses, the first of those stands in for
    // an ambient scope — see `effectiveScope`. Authority is unchanged: it is still a granted scope.
    const scope = effectiveScope(tool.descriptor.name, args)
    if (!isConnectorTool(tool)) return runLocal(id, tool.descriptor.name, scope, args, caller)
    const chosen = config.resolverFor(scope, caller)
    if ('refusal' in chosen) {
      // A tool result, not a JSON-RPC error: the model has to read it and pick a scope.
      return Effect.succeed(ok(id, toolError(chosen.refusal)))
    }
    const message: DappMessage = {
      id: config.nextRequestId(),
      chainType: tool.chainType,
      method: tool.method,
      origin: config.session.origin,
      ...(config.session.sessionId !== undefined ? {sessionId: config.session.sessionId} : {}),
      // ⚠️ Shaped, not forwarded. The two chains disagree about param shape and MCP has only one, and a
      // no-argument tool must send **no params at all** — `{}` is what a client sends and what Midnight's
      // `noParams` guard rejects. See {@link paramsFor}.
      ...((): {params?: unknown} => {
        const params = paramsFor(tool, args)
        return params === undefined ? {} : {params}
      })(),
    }
    return chosen.resolve(message).pipe(
      Effect.map((response: WalletResponse) =>
        // A connector wire error is the wallet refusing — locked, no session, bad params. The model has
        // to see the reason, so it becomes an `isError` result rather than a JSON-RPC error.
        ok(id, response.error !== undefined ? toolError(response.error.message) : toolOk(response.result)),
      ),
    )
  }

  const handle = (frame: JsonRpcRequest, caller?: McpCaller): Effect.Effect<JsonRpcResponse | null, SentinelError> => {
    // ⚠️ A notification has no `id` and gets **no reply, whatever the method** — answering one is a
    // protocol violation the client may drop the connection over, and there is no id to answer under.
    // Checked before anything else so no method can accidentally opt out of it; the first draft let
    // `tools/list` answer with `id: null`, which a test caught.
    //
    // A `tools/call` notification is therefore also never *executed*: acting with nowhere to report the
    // outcome is the wrong direction for a wallet to fail in.
    if (frame.id === undefined) return Effect.succeed(null)
    if (frame.jsonrpc !== '2.0') {
      return Effect.succeed(fail(frame.id, JsonRpcErrorCode.InvalidRequest, 'jsonrpc must be "2.0"'))
    }
    switch (frame.method) {
      case 'initialize': {
        const requested = (frame.params as {protocolVersion?: unknown} | undefined)?.protocolVersion
        return Effect.succeed(
          ok(frame.id, {
            protocolVersion: negotiate(requested),
            // Only what is actually implemented. Claiming a capability here and answering its method
            // with an error is worse than not claiming it — `resources` is listed because
            // `resources/list` and `resources/read` are both served below.
            capabilities: {tools: {}, resources: {}},
            serverInfo: config.serverInfo,
            instructions: config.instructions,
          }),
        )
      }
      case 'ping':
        return Effect.succeed(ok(frame.id, {}))
      case 'tools/list': {
        const visible = config.toolVisible
        const tools =
          visible === undefined ? toolDescriptors() : toolDescriptors().filter((d) => visible(d.name, caller))
        return Effect.succeed(ok(frame.id, {tools}))
      }
      case 'tools/call':
        return callTool(frame.id, frame.params, caller)
      // The on-demand documentation channel. It costs an agent nothing until it reads one, which is why
      // the reference lives here and only the prohibitions live in `instructions`.
      case 'resources/list':
        return Effect.succeed(ok(frame.id, {resources: resourceDescriptors()}))
      case 'resources/read': {
        const uri = (frame.params as {uri?: unknown} | undefined)?.uri
        if (typeof uri !== 'string') {
          return Effect.succeed(fail(frame.id, JsonRpcErrorCode.InvalidParams, 'resources/read needs a uri'))
        }
        const doc = findResource(uri)
        // ⚠️ A protocol error, not a tool-style result: the client asked for a URI that is not in the
        // list it was given, so there is nothing for a model to act on beyond listing again.
        if (doc === undefined) {
          return Effect.succeed(fail(frame.id, JsonRpcErrorCode.InvalidParams, `no such resource: ${uri}`))
        }
        return Effect.succeed(ok(frame.id, {contents: [{uri: doc.uri, mimeType: doc.mimeType, text: doc.text}]}))
      }
      default:
        return Effect.succeed(fail(frame.id, JsonRpcErrorCode.MethodNotFound, `unsupported method: ${frame.method}`))
    }
  }

  return {handle}
}
