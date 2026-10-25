/**
 * Pnyx logger MCP server.
 *
 * Runs a stdio MCP endpoint (consumed by Claude Code via .mcp.json) plus a
 * local HTTP ingest endpoint that the wallet's `localStreamTransport` POSTs
 * log batches to. Lets the agent inspect a live tail of wallet/extension logs
 * (perf marks, errors, breadcrumbs) without manual paste.
 *
 * Usage:
 *   bun app/scripts/logger-mcp/server.ts
 *
 * Env:
 *   PNYX_LOGGER_MCP_PORT       HTTP ingest port (default 9876)
 *   PNYX_LOGGER_MCP_HOSTNAME   Bind hostname (default 0.0.0.0 — phones over LAN)
 *   PNYX_LOGGER_MCP_CAP        Ring buffer capacity (default 5000)
 *
 * @module
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'

import {createLogStore, type LogEntry} from './store'

const PORT = Number(process.env.PNYX_LOGGER_MCP_PORT ?? '9876')
const CAP = Number(process.env.PNYX_LOGGER_MCP_CAP ?? '5000')

const log = (msg: string): void => {
  process.stderr.write(`[pnyx-logger] ${msg}\n`)
}

const store = createLogStore(CAP)

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
} as const

const isLogEntry = (v: unknown): v is LogEntry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.source === 'string' &&
    typeof e.level === 'string' &&
    typeof e.message === 'string' &&
    typeof e.timestamp === 'number' &&
    typeof e.metadata === 'object' &&
    e.metadata !== null
  )
}

// Bind to all interfaces so React Native dev builds on a phone can POST
// over the LAN. Dev-only by construction (this script is never bundled
// into a shipped artifact); do not run it on a non-trusted network.
const HOSTNAME = process.env.PNYX_LOGGER_MCP_HOSTNAME ?? '0.0.0.0'

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders})
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/logs') {
      try {
        const body = (await req.json()) as {entries?: unknown}
        const entries = Array.isArray(body.entries) ? body.entries.filter(isLogEntry) : []
        if (entries.length > 0) store.pushBatch(entries)
        return new Response(null, {status: 204, headers: corsHeaders})
      } catch {
        return new Response('bad request', {status: 400, headers: corsHeaders})
      }
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ok: true, total: store.summary().total}, {headers: corsHeaders})
    }

    return new Response('not found', {status: 404, headers: corsHeaders})
  },
  error: (err: Error) => {
    log(`http error: ${err.message}`)
    return new Response('internal error', {status: 500, headers: corsHeaders})
  },
})

log(`HTTP ingest listening on http://${HOSTNAME}:${PORT}/logs (cap=${CAP})`)

const mcp = new McpServer({name: 'pnyx-logger', version: '0.1.0'})

mcp.registerTool(
  'logs_read',
  {
    description:
      'Read recent wallet/extension log entries from the in-memory buffer. Supports filtering by time range, level, source, origin prefix, and message substring. Returns most recent entries up to limit.',
    inputSchema: {
      since: z.number().optional().describe('Unix epoch ms; only entries with timestamp >= this'),
      until: z.number().optional().describe('Unix epoch ms; only entries with timestamp <= this'),
      level: z.string().optional().describe('Comma-separated subset of: debug, info, warn, error'),
      source: z.string().optional().describe('Source tag: app | extension-bg'),
      originPrefix: z.string().optional().describe('Filter by metadata.origin prefix (e.g. "perf:")'),
      messageSubstr: z.string().optional().describe('Substring match against message text'),
      limit: z.number().int().positive().max(2000).optional().describe('Max entries (default 200)'),
    },
  },
  async (input) => {
    const entries = store.read(input)
    return {
      content: [{type: 'text', text: JSON.stringify({count: entries.length, entries}, null, 2)}],
    }
  },
)

mcp.registerTool(
  'logs_clear',
  {
    description: 'Clear the in-memory log buffer. Use before running a scenario to capture a clean slice.',
    inputSchema: {},
  },
  async () => {
    store.clear()
    return {content: [{type: 'text', text: 'Cleared.'}]}
  },
)

mcp.registerTool(
  'logs_summary',
  {
    description:
      'Summarize the current buffer: total count, breakdown by level and source, top origins, time range. Cheap snapshot — call before logs_read to see what is worth filtering for.',
    inputSchema: {},
  },
  async () => {
    const s = store.summary()
    return {content: [{type: 'text', text: JSON.stringify(s, null, 2)}]}
  },
)

const transport = new StdioServerTransport()
await mcp.connect(transport)
log('MCP stdio server connected')
