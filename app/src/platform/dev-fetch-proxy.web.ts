/**
 * Patches globalThis.fetch on web in dev mode to rewrite CORS-blocked API URLs
 * through the local dev proxy, avoiding CORS errors.
 *
 * Local web talks directly to hosted backend APIs, whose deployed CORS
 * policy may not include localhost. This patch intercepts those requests
 * and routes them through the dev proxy server (scripts/dev-proxy.ts)
 * running on localhost:3001.
 *
 * @module
 */

const DEV_PROXY_BASE = 'http://localhost:3001'

/**
 * Hostnames proxied via the generic passthrough route because they don't send
 * CORS headers admitting the localhost dev origin — none of this matters to
 * the native app (its fetch isn't subject to CORS), only to the web target.
 * `pnyx.pxkq.uk` is the content Worker; `config`/`data.pxkq.uk` are R2-direct
 * public buckets, which serve no `Access-Control-Allow-Origin` by default.
 *
 * `api.koios.rest`'s CORS is unreliable — its preflight sometimes omits
 * `Access-Control-Allow-Origin`, which blocks every request from the localhost
 * dev origin. The proxy adds CORS headers deterministically, so route Koios
 * through it. (Dev-web only; the native app's fetch isn't subject to CORS.)
 */
const passthroughHosts: ReadonlyArray<string> = [
  'pnyx.pxkq.uk',
  'config.pxkq.uk',
  'data.pxkq.uk',
  'api.koios.rest',
  // The testnet Koios hosts have the same unreliable CORS as the mainnet one, and
  // dev work happens on preprod — without these, every Koios read on a testnet
  // (DRep info, CIP-146 discovery) fails from the localhost origin.
  'preprod.koios.rest',
  'preview.koios.rest',
  // SteelSwap's `/api/v2/*` fetch() calls (metadata/prices/quote/anon-mint) are
  // CORS-gated from the localhost dev origin. The `/tokens/icon/` PNG loads as an
  // <img> (not CORS-gated), so it doesn't strictly need this — but routing it
  // through too is harmless.
  'cicdapi.steelswap.io',
  // SteelSwap v1 production web API (swap estimate/build). Same CORS gating; the
  // proxy also injects the origin/referer this host requires (see dev-proxy.ts).
  'api.steelswap.io',
]

function rewriteUrl(url: string): string {
  // Generic passthrough: encode the full upstream URL so the proxy can forward it as-is
  for (const host of passthroughHosts) {
    if (url.includes(host)) {
      return `${DEV_PROXY_BASE}/__proxy/passthrough?url=${encodeURIComponent(url)}`
    }
  }
  return url
}

const originalFetch = globalThis.fetch

const patchedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (typeof input === 'string') {
    const rewritten = rewriteUrl(input)
    if (rewritten !== input) {
      if (__DEV__) console.log(`[dev-fetch-proxy] ${input} → ${rewritten}`)
      return originalFetch(rewritten, init)
    }
  } else if (input instanceof URL) {
    const rewritten = rewriteUrl(input.href)
    if (rewritten !== input.href) {
      if (__DEV__) console.log(`[dev-fetch-proxy] ${input.href} → ${rewritten}`)
      return originalFetch(rewritten, init)
    }
  } else if (input instanceof Request) {
    const rewritten = rewriteUrl(input.url)
    if (rewritten !== input.url) {
      if (__DEV__) console.log(`[dev-fetch-proxy] ${input.url} → ${rewritten}`)
      return originalFetch(new Request(rewritten, input), init)
    }
  }
  return originalFetch(input as RequestInfo, init)
}

Object.assign(patchedFetch, {preconnect: originalFetch.preconnect})
globalThis.fetch = patchedFetch as typeof fetch
