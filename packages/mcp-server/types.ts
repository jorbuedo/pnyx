/**
 * MCP wire types — JSON-RPC 2.0 plus the handful of MCP methods a wallet server needs.
 *
 * **Hand-rolled rather than depending on `@modelcontextprotocol/sdk`, deliberately.** The server side
 * of MCP that this needs is `initialize`, `tools/list`, `tools/call` and later `resources/*` — a small,
 * stable surface over JSON-RPC. The alternative is a dependency that has to run in **Hermes** on the
 * device, because the tool surface lives there (the relay is a dumb pipe) — the same bet that has cost
 * this repo before: `@midnight-ntwrk/compact-runtime` broke the Android bundle, and Hermes has no WASM.
 * It is also a third-party dependency needing approval, and it buys little at this size.
 *
 * ⚠️ **The protocol version is a pinned constant and must be verified against the current spec**, not
 * trusted from this file. MCP's authorization section in particular was revised recently.
 *
 * @module
 */

/** Protocol revisions this server will negotiate, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26']

/** What we answer with when the client asks for a revision we do not know. */
export const PREFERRED_PROTOCOL_VERSION: string = '2025-06-18'

export type JsonRpcId = string | number

/** A request expects a reply; a notification (no `id`) does not. */
export type JsonRpcRequest = {
  readonly jsonrpc: '2.0'
  readonly id?: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export type JsonRpcError = {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type JsonRpcResponse = {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId | null
  readonly result?: unknown
  readonly error?: JsonRpcError
}

/** JSON-RPC 2.0's reserved range. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

/**
 * A tool as `tools/list` describes it.
 *
 * `inputSchema` is JSON Schema and is the only thing telling an agent how to call the tool, so it is
 * part of the contract rather than documentation.
 */
export type ToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, unknown>>
    readonly required?: readonly string[]
    readonly additionalProperties?: boolean
  }
}

/**
 * A `tools/call` result.
 *
 * ⚠️ **A tool that fails returns `isError: true`, not a JSON-RPC error.** The distinction is
 * load-bearing: a JSON-RPC error is a protocol failure the client handles, where `isError` is a result
 * the *model* sees and can act on. Refusing a call because the wallet is locked is the second kind — an
 * agent that never sees the reason cannot ask the user to unlock.
 */
export type ToolResult = {
  readonly content: readonly {readonly type: 'text'; readonly text: string}[]
  readonly isError?: boolean
}
