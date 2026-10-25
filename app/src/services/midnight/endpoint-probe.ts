/**
 * Does an endpoint answer?
 *
 * The settings screen can point the wallet anywhere, which means it can point it somewhere wrong,
 * and the symptom of wrong is a sync that quietly never completes. A probe turns that into an
 * answer you get while you are still looking at the field.
 *
 * Each kind is asked the cheapest question that proves it is the right *kind* of server, not merely
 * that something is listening:
 *
 * | kind     | asked                                   | accepted when |
 * |----------|-----------------------------------------|---------------|
 * | `indexer`| GraphQL `{ block { height } }`           | a numeric height comes back |
 * | `node`   | JSON-RPC `system_chain`                 | a chain name comes back |
 * | `nodeWs` | a websocket handshake                   | the socket opens |
 *
 * A 200 carrying a GraphQL `errors` array is a refusal, not a pass: Blockfrost answers a missing
 * `project_id` that way, and treating it as success is how a broken endpoint gets saved.
 *
 * ⚠️ **Timeouts are `AbortController` + `setTimeout`, never `AbortSignal.timeout()`.** Hermes has no
 * `AbortSignal` statics, and calling one throws *before* the request is made, so the probe would
 * report a failure it never attempted. Node tests would pass either way.
 *
 * @module
 */

import type {EndpointKind} from '../../config/chain-endpoints'
import {logger} from '../../logger'
import {indexerAuthHeaders} from './indexer-auth'

export type ProbeResult =
  | {readonly status: 'accepted'; readonly detail: string}
  | {readonly status: 'refused'; readonly detail: string}

/** Injected so tests drive the transports rather than the network. */
export type ProbeDeps = {
  readonly fetchImpl: typeof fetch
  readonly openSocket: (url: string) => {
    close: () => void
    onopen: ((...args: never[]) => void) | null
    onerror: ((...args: never[]) => void) | null
  }
  readonly timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 10_000

const withTimeout = async <T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const probeIndexer = async (url: string, deps: ProbeDeps): Promise<ProbeResult> =>
  withTimeout(deps.timeoutMs, async (signal) => {
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...indexerAuthHeaders(url)},
      body: JSON.stringify({query: '{ block { height } }'}),
      signal,
    })
    if (!response.ok) return {status: 'refused', detail: `HTTP ${response.status}`}
    const body = (await response.json()) as {
      data?: {block?: {height?: unknown}}
      errors?: ReadonlyArray<{message?: string}>
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return {status: 'refused', detail: body.errors[0]?.message ?? 'GraphQL error'}
    }
    const height = body.data?.block?.height
    if (typeof height !== 'number') return {status: 'refused', detail: 'no block height in the answer'}
    return {status: 'accepted', detail: `block ${height}`}
  })

const probeNode = async (url: string, deps: ProbeDeps): Promise<ProbeResult> =>
  withTimeout(deps.timeoutMs, async (signal) => {
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'system_chain', params: []}),
      signal,
    })
    if (!response.ok) return {status: 'refused', detail: `HTTP ${response.status}`}
    const body = (await response.json()) as {result?: unknown; error?: {message?: string}}
    if (body.error !== undefined) return {status: 'refused', detail: body.error.message ?? 'RPC error'}
    if (typeof body.result !== 'string') return {status: 'refused', detail: 'no chain name in the answer'}
    return {status: 'accepted', detail: body.result}
  })

const probeSocket = (url: string, deps: ProbeDeps): Promise<ProbeResult> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch (error) {
        logger.debug('probe socket would not close', {error: String(error)})
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({status: 'refused', detail: 'timed out'}), deps.timeoutMs)
    const socket = deps.openSocket(url)
    socket.onopen = () => finish({status: 'accepted', detail: 'socket opened'})
    socket.onerror = () => finish({status: 'refused', detail: 'socket refused'})
  })

/**
 * Probe one endpoint. Never throws: a probe that threw would be indistinguishable from a probe that
 * was never run, and the whole point is to replace silence with an answer.
 */
export const probeEndpoint = async (
  kind: EndpointKind,
  url: string,
  deps: Partial<ProbeDeps> = {},
): Promise<ProbeResult> => {
  const resolved: ProbeDeps = {
    fetchImpl: deps.fetchImpl ?? fetch,
    openSocket:
      deps.openSocket ?? ((target: string) => new WebSocket(target) as unknown as ReturnType<ProbeDeps['openSocket']>),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  try {
    if (kind === 'indexer') return await probeIndexer(url, resolved)
    if (kind === 'node') return await probeNode(url, resolved)
    return await probeSocket(url, resolved)
  } catch (error) {
    const detail = String(error)
    logger.warn('endpoint probe failed', {kind, error: detail})
    return {status: 'refused', detail: detail.includes('aborted') ? 'timed out' : detail.replace(/^Error:\s*/, '')}
  }
}
