#!/usr/bin/env bun
/**
 * Standalone dev proxy server for API calls.
 *
 * Runs in its own process so proxy requests are not blocked by Metro's
 * bundler event loop. This fixes 5-44s latency caused by event loop
 * starvation when the proxy was embedded in metro.config.js.
 *
 * Usage:
 *   bun scripts/dev-proxy.ts          # Start on default port 3001
 *   PORT=3002 bun scripts/dev-proxy.ts  # Start on custom port
 *
 * @module
 */

const PORT = Number(process.env.DEV_PROXY_PORT ?? '3001')
const METRO_ORIGIN = process.env.METRO_ORIGIN ?? 'http://localhost:8081'

/** Block private/internal hostnames to prevent SSRF via the passthrough proxy. */
function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  // IPv4 private ranges
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const [, aStr, bStr] = ipv4
    const a = Number(aStr)
    const b = Number(bStr)
    if (a === 127) return true // loopback
    if (a === 10) return true // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local
    if (a === 0) return true // 0.0.0.0/8
  }
  return false
}

/** Fixed-prefix upstream targets. Empty by default — add entries as needed. */
const proxyTargets: Record<string, {target: string; strip: string}> = {}

// Order matters: more specific prefixes first
const orderedPrefixes: readonly string[] = []

const corsHeaders = {
  'Access-Control-Allow-Origin': METRO_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  // `token` is SteelSwap's v1 auth header. Omitting it made the browser fail the
  // preflight and report `net::ERR_FAILED`, which looks like an upstream outage
  // from the app side — it masked the real upstream status for the whole v1 rail.
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, token, X-Connector-Id, X-Chain-Arch, X-Company-Id, X-Chain-Id, X-User-Email, X-User-Address',
  'Access-Control-Allow-Credentials': 'true',
} as const

function findProxy(pathname: string): {target: string; strip: string} | undefined {
  for (const prefix of orderedPrefixes) {
    if (pathname.startsWith(prefix)) return proxyTargets[prefix]
  }
  return undefined
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // Handle CORS preflight for any proxy route
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/__proxy/')) {
      return new Response(null, {status: 204, headers: corsHeaders})
    }

    // Generic passthrough: forward to the exact URL specified in the query param.
    // Used for CORS-blocked RPC nodes whose hostnames are dynamic (e.g. Zeeve).
    if (url.pathname === '/__proxy/passthrough') {
      const upstreamUrl = url.searchParams.get('url')
      if (!upstreamUrl) return new Response('Missing url param', {status: 400, headers: corsHeaders})

      // Validate upstream URL to prevent SSRF
      let parsed: URL
      try {
        parsed = new URL(upstreamUrl)
      } catch {
        return new Response('Invalid URL', {status: 400, headers: corsHeaders})
      }
      if (parsed.protocol !== 'https:') {
        return new Response('Only https:// URLs are allowed', {status: 403, headers: corsHeaders})
      }
      if (isPrivateHostname(parsed.hostname)) {
        return new Response('Requests to private/internal hosts are blocked', {status: 403, headers: corsHeaders})
      }

      try {
        const headers = new Headers(req.headers)
        headers.delete('host')
        headers.delete('origin')
        headers.delete('referer')
        // SteelSwap's v1 web API (api.steelswap.io) gates on an app origin. The
        // browser forbids the app from setting origin/referer, so inject them
        // here on the proxy hop (dev/web only; native fetch sets them directly).
        if (parsed.hostname.endsWith('.steelswap.io')) {
          headers.set('origin', 'https://steelswap.io')
          headers.set('referer', 'https://steelswap.io/')
        }
        const res = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
          redirect: 'manual',
        })
        const responseHeaders = new Headers(res.headers)
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
        for (const [key, value] of Object.entries(corsHeaders)) {
          responseHeaders.set(key, value)
        }
        return new Response(res.body, {status: res.status, statusText: res.statusText, headers: responseHeaders})
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[proxy] Passthrough error: ${req.method} ${upstreamUrl} — ${msg}`)
        return new Response(JSON.stringify({error: 'Proxy error', message: msg}), {
          status: 502,
          headers: {'Content-Type': 'application/json', ...corsHeaders},
        })
      }
    }

    const proxy = findProxy(url.pathname)

    if (!proxy) {
      return new Response('Not found', {status: 404})
    }

    const upstreamPath = url.pathname.replace(proxy.strip, '') + url.search
    const upstreamUrl = `${proxy.target}${upstreamPath}`

    try {
      // Forward the request, copying method, headers, and body
      const headers = new Headers(req.headers)
      // Remove host header so upstream gets the correct one
      headers.delete('host')
      headers.delete('origin')
      headers.delete('referer')

      const res = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
        redirect: 'manual',
      })

      // Build response with CORS headers.
      // Bun's fetch auto-decompresses gzip, so strip Content-Encoding and
      // Content-Length (now stale) to avoid ERR_CONTENT_DECODING_FAILED.
      const responseHeaders = new Headers(res.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, value)
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[proxy] Error: ${req.method} ${upstreamPath} — ${msg}`)
      return new Response(JSON.stringify({error: 'Proxy error', message: msg}), {
        status: 502,
        headers: {'Content-Type': 'application/json', ...corsHeaders},
      })
    }
  },
})

console.log(`[dev-proxy] Listening on http://localhost:${server.port}`)
console.log(`[dev-proxy] CORS origin: ${METRO_ORIGIN}`)
console.log(`[dev-proxy] Routes:`)
for (const [prefix, {target}] of Object.entries(proxyTargets)) {
  console.log(`  ${prefix}/* → ${target}/*`)
}
console.log(`  /__proxy/passthrough?url=<url> → passthrough (for CORS-blocked RPC nodes)`)
