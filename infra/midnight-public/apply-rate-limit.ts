/**
 * Put a rate limit in front of the self-hosted indexer, at Cloudflare's edge.
 *
 *   CF_API_TOKEN=… CF_ZONE_ID=… CF_RATE_LIMIT_HOSTNAME=… \
 *     bun infra/midnight-public/apply-rate-limit.ts [--dry-run]
 *
 * The origin is an unauthenticated GraphQL API running the ledger-v8 indexer line, which does not
 * carry fix #1440: `indexer-api` wedges under concurrent ledger-DB reads, and the resolvers that do
 * it are the dust and merkle-tree ones that wallet sync drives anyway. Until that fix reaches the
 * v8 line, anyone who finds the hostname can stop our indexer from a laptop. The edge is the right
 * place to cap that because it costs the origin nothing.
 *
 * **The limit is sized for one wallet's worst honest burst, not for an average one.** A DUST
 * rebuild walks generation and commitment updates one query at a time, so a single device can
 * legitimately send a burst of requests; 100 per 10 s (~10 req/s sustained) leaves that room while
 * still being two orders of magnitude below what a flood would need. The 10 s window and the 10 s
 * block are the only values this zone's plan allows; other values are rejected ("can only use a
 * period among [10]", "mitigation timeout different from 10").
 *
 * ⚠️ **This merges rather than replaces.** `PUT …/rulesets/phases/http_ratelimit/entrypoint` writes
 * the whole phase for the zone, so a blind PUT would silently delete whatever protects
 * `media.pxkq.uk` and `config.pxkq.uk`. The script reads the phase first, drops only its own rule by
 * description, appends the current one, and writes the result back.
 *
 * Needs a token with Zone:WAF:Edit on the zone (the account's wrangler OAuth token has no zone
 * scopes at all, which is why this is not wired into anything automatic).
 */

/** Required, with no default: a wrong zone id edits WAF rules on somebody else's zone. */
const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`${name} is required. Set it to this deployment's value and re-run.`)
    process.exit(2)
  }
  return value
}

const ZONE = required('CF_ZONE_ID')
const HOSTNAME = required('CF_RATE_LIMIT_HOSTNAME')
const DESCRIPTION = 'pnyx: midnight indexer per-IP cap'
const REQUESTS_PER_PERIOD = 100
const PERIOD_SECONDS = 10
const BLOCK_SECONDS = 10

const token = process.env.CF_API_TOKEN
if (!token) throw new Error('CF_API_TOKEN is required (Zone:WAF:Edit on pxkq.uk)')
const dryRun = process.argv.includes('--dry-run')

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {})},
  })
  const body = (await response.json()) as {success: boolean; result?: unknown; errors?: {message?: string}[]}
  if (!body.success) {
    throw new Error(`${path}: ${(body.errors ?? []).map((e) => e.message).join('; ') || response.status}`)
  }
  return body.result
}

const rule = {
  description: DESCRIPTION,
  expression: `http.host eq "${HOSTNAME}"`,
  action: 'block',
  ratelimit: {
    characteristics: ['ip.src', 'cf.colo.id'],
    period: PERIOD_SECONDS,
    requests_per_period: REQUESTS_PER_PERIOD,
    mitigation_timeout: BLOCK_SECONDS,
  },
}

// The entrypoint ruleset for a phase does not exist until the first rule is written. A GET then
// 404s ("could not find entrypoint ruleset"), which is not an error here — it means "no rules yet".
let existing: {description?: string}[] = []
try {
  const phase = (await api(`/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`)) as {
    rules?: {description?: string}[]
  }
  existing = phase.rules ?? []
} catch (error) {
  if (!String(error).includes('could not find entrypoint ruleset')) throw error
  console.log('no rate-limit phase yet; this creates it')
}
const kept = existing.filter((r) => r.description !== DESCRIPTION)
console.log(`phase has ${existing.length} rule(s); keeping ${kept.length}, then appending ours`)
for (const r of kept) console.log(`  keeping: ${r.description ?? '(no description)'}`)

if (dryRun) {
  console.log(JSON.stringify({rules: [...kept, rule]}, null, 2))
  console.log('dry run: nothing written')
} else {
  await api(`/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({rules: [...kept, rule]}),
  })
  console.log(
    `applied: ${REQUESTS_PER_PERIOD} requests / ${PERIOD_SECONDS}s per IP on ${HOSTNAME}, blocking ${BLOCK_SECONDS}s`,
  )
}
