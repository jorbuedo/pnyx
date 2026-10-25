/**
 * Local stream transport — POSTs log entries to a local MCP server in dev.
 *
 * Web / extension contexts hit `http://localhost:9876/logs`. React Native dev
 * builds on a phone over Wi-Fi resolve the dev-machine LAN IP from the Expo
 * `hostUri` (same IP Metro uses) and POST to `http://<lan-ip>:9876/logs`.
 * `EXPO_PUBLIC_DEV_LOG_STREAM_HOST` overrides discovery (set it to `host` or
 * `host:port` if you run the MCP server somewhere non-default).
 *
 * If the MCP server isn't running the queue keeps entries up to a cap and drains on
 * the first successful POST. The first unreachable POST is reported once via `console`
 * — this is the log transport, so it cannot report through the logger.
 *
 * @module
 */

import type {LogTransport, LogTransportOptions} from '@pnyx/logger'
import {devLogStreamHost} from '../config/env'

const DEFAULT_PORT = 9876
const DEFAULT_FLUSH_MS = 250
const DEFAULT_MAX_BATCH = 100
const DEFAULT_QUEUE_CAP = 500
const MAX_VALUE_DEPTH = 4

export type LocalStreamTransportOptions = {
  endpoint: string
  source: string
  flushIntervalMs?: number
  maxBatchSize?: number
  queueCap?: number
}

type Entry = {
  source: string
  level: string
  message: string
  metadata: Record<string, unknown>
  timestamp: number
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

const safeJson = (v: unknown, depth: number): unknown => {
  if (v === null || v === undefined) return v
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return v
  if (t === 'bigint') return (v as bigint).toString()
  if (v instanceof Error) return {name: v.name, message: v.message, stack: v.stack}
  if (depth <= 0) return '[truncated]'
  if (Array.isArray(v)) return v.map((x) => safeJson(x, depth - 1))
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = safeJson(val, depth - 1)
    return out
  }
  return String(v)
}

/**
 * Resolve the `/logs` endpoint for the local MCP server, or `null` if we
 * can't reach it from this runtime.
 *
 * Priority:
 *   1. `EXPO_PUBLIC_DEV_LOG_STREAM_HOST` (full host, or `host:port`)
 *   2. Web / extension runtimes (have a `location` global) → `localhost`
 *   3. React Native: parse host from Expo's `hostUri` (the same LAN IP Metro
 *      bound to). Fails closed if `hostUri` isn't a parseable `host[:port]`.
 */
export const resolveLocalStreamEndpoint = (hostUri?: string | null): string | null => {
  const override = devLogStreamHost()
  if (override) {
    const hasPort = override.includes(':')
    return hasPort ? `http://${override}/logs` : `http://${override}:${DEFAULT_PORT}/logs`
  }

  if (typeof location !== 'undefined') return `http://localhost:${DEFAULT_PORT}/logs`

  if (typeof hostUri === 'string' && hostUri.length > 0) {
    const host = hostUri.split(':')[0]
    if (host) return `http://${host}:${DEFAULT_PORT}/logs`
  }

  return null
}

/**
 * Is this URL the local dev log sink?
 *
 * ⚠️ Anything that traces HTTP must skip it. The dev fetch proxy logs four DEBUG lines per
 * request; shipping those four is itself a request, which logs four more, so tracing the sink
 * is a loop that never drains — measured on the emulator 2026-08-29 at ~3 batches/second with
 * nothing else running. Matched on port + path rather than the resolved endpoint because the
 * tracer has no access to Expo's `hostUri`, and deliberately without a try/catch: a parse this
 * cannot report through the logger it is protecting.
 */
export const isLocalStreamEndpoint = (url: string): boolean => {
  const override = devLogStreamHost()
  const port = override?.includes(':') === true ? (override.split(':')[1] ?? '') : String(DEFAULT_PORT)
  return port !== '' && url.endsWith(`:${port}/logs`)
}

export const createLocalStreamTransport = (options: LocalStreamTransportOptions): LogTransport => {
  const {
    endpoint,
    source,
    flushIntervalMs = DEFAULT_FLUSH_MS,
    maxBatchSize = DEFAULT_MAX_BATCH,
    queueCap = DEFAULT_QUEUE_CAP,
  } = options

  const queue: Entry[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let reportedUnreachable = false

  const flush = (): void => {
    timer = null
    if (inFlight || queue.length === 0) return
    const batch = queue.slice(0, maxBatchSize)
    inFlight = true
    fetch(endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({entries: batch}),
      keepalive: true,
    })
      .then((res) => {
        inFlight = false
        if (res.ok) {
          queue.splice(0, batch.length)
          if (queue.length > 0) schedule()
        } else {
          // Server replied with error — drop this batch to avoid head-of-line blocking
          queue.splice(0, batch.length)
        }
      })
      .catch((e) => {
        inFlight = false
        // Server unreachable — keep entries queued (subject to cap), retry on next tick.
        // Reported once per session: the retry runs every flush interval, and routing this
        // through the logger would feed the transport that just failed.
        if (!reportedUnreachable) {
          reportedUnreachable = true
          console.warn(`[local-stream-transport] ${endpoint} unreachable, queueing logs: ${String(e)}`)
        }
        schedule()
      })
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(flush, flushIntervalMs)
  }

  return ({level, message, metadata, timestamp}: LogTransportOptions) => {
    const messageStr = message instanceof Error ? `${message.name}: ${message.message}` : message
    const safeMeta = (safeJson(metadata, MAX_VALUE_DEPTH) ?? {}) as Record<string, unknown>
    queue.push({source, level, message: messageStr, metadata: safeMeta, timestamp})
    while (queue.length > queueCap) queue.shift()
    if (queue.length >= maxBatchSize) flush()
    else schedule()
  }
}
