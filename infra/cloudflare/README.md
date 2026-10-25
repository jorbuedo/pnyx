# Cloudflare

Everything of ours that runs on Cloudflare, and where to change it. The **zone is `pxkq.uk`**; every
public name the app talks to is on it.

This is a map, not a second copy of the docs — each row names the file or doc that owns the detail.
Worker *source* deliberately stays in `services/`: `wrangler` resolves `main` and the asset directory
relative to its own config, so a config split from its source would need `--config` on every command
for nothing. What lives here is the part that is not in any Worker: who answers which hostname, which
of them are not Workers at all, and the traps that cost a session each.

## What answers what

| hostname | what it is | owned by |
|---|---|---|
| `pnyx.pxkq.uk` | the content Worker: auth, content store, DM relay, realtime DO, MCP relay, `/chain/*` → the sponsor | `services/content/` |
| `config.pxkq.uk` | the control plane. R2 `pnyx-config`, read **R2-direct** (`<env>.json`, env ∈ dev/preview/prod) | `docs/remote-config.md`, `docs/CHAIN_ENDPOINTS.md` |
| `artifacts.pxkq.uk` | ZK circuit artifacts + the KZG SRS. R2 `pnyx-artifacts`, read R2-direct | `docs/CONTRACT_MIGRATION.md` |
| `data.pxkq.uk` | slow data (DReps, pools, pricing). R2 `pnyx-data`, read R2-direct | `services/data-worker/` |
| `sponsor.pxkq.uk` | the sponsor host, through a Tunnel | [`../sponsor-host/`](../sponsor-host/) |
| `midnight-mainnet.pxkq.uk` | our self-hosted Midnight indexer, through a Tunnel | [`../midnight-public/`](../midnight-public/) |
| `media.pxkq.uk` | token media stills. nginx on the Pi, through a Tunnel | `docs/CARDANO_TOKEN_DATA.md` |
| `www.pxkq.uk` | the public landing page at `/pnyx`. **Static assets only — no Worker script** | `services/landing/` |
| `downloads.pxkq.uk` | pre-release builds. R2 `pnyx-releases`, read **R2-direct** | [`../releases/`](../releases/) |

⚠️ **Six of these never invoke a Worker.** `config`, `artifacts`, `data` and `downloads` are R2
custom domains read directly by the client, `media` is a tunnelled origin, and `www` is a
static-asset deployment with no script — so a Worker deploy cannot change them and a Worker log
will never show their traffic. `data.pxkq.uk` in particular is served *past*
`pnyx-data`, which is a cron-only Worker with no public route.

## The two Workers, and one deployment that is not one

```bash
cd services/content     && bunx wrangler deploy   # pnyx-content
cd services/data-worker && bunx wrangler deploy   # pnyx-data
cd services/landing     && bunx wrangler deploy   # pnyx-landing — assets only, no script
```

`pnyx-content` carries D1 `pnyx-content`, R2 `pnyx-bug-reports`, two Durable Objects
(`RealtimeHub`, `McpRelay`), three rate-limit namespaces, the `/.well-known/*` static assets, and a
daily `17 4 * * *` DM-retention sweep. `pnyx-data` is cron-only (`0 5 * * *`) and refreshes its R2
blobs; it has no route, so reach it at its `workers.dev` URL for a manual `/refresh`.

`pnyx-landing` holds the custom domain for **the whole of `www.pxkq.uk`**, not just `/pnyx` — a
custom domain cannot be scoped to a path. Anything else that ever wants a path on www has to be
served by it. It has no secrets, no state and **no script**: `wrangler.jsonc` has no `main`, so
every request it answers is a free static asset and nothing is billed per request. Adding `main`
back would change that — read `services/landing/README.md` first.

⚠️ **Deploying is what arms a cron.** There is no separate switch for `triggers.crons` — the
retention sweep and the data refresh start on the `wrangler deploy` that introduces them.

### Secrets, and why each is one

Vars live in `wrangler.jsonc` where they can be read; only credentials are secrets.

| secret | Worker | why |
|---|---|---|
| `MIDNIGHT_INDEXER_PROJECT_ID` | `pnyx-content` | the Blockfrost key, sent as a **`project_id` header**. ⚠️ Not in the URL: a URL reaches logs, error strings and — through the connector's `configuration` — every dApp the wallet connects to |

```bash
cd services/content && bunx wrangler secret put MIDNIGHT_INDEXER_PROJECT_ID
```

⚠️ **Without it every identity-row read 403s, which refuses every login while `/register` keeps
working** — registration never reads a row. That asymmetry is what made the 2026-10-13 outage read
as a client bug; see the s162 entry in `docs/FOLLOW_UPS.md`.

⚠️ The header name is literally `project_id`. `Project-Id` is a *different header* and 403s — the
hyphen, not the case.

## Tunnels

Three, one per tunnelled box: **`pnyx-sponsor`** (the VPS), **`pnyx-midnight`** (the Mac) and
**`pnyx-media`** (the Pi). Each runs `cloudflared tunnel run --token-file` with a **dashboard-managed
ingress rule and no local `config.yml`**, so the mapping from hostname to local port is the one part
of this that cannot be configured from the repo. Each box holds its connector token at mode 0600 and
nowhere else; `cloudflared` dials out and nothing listens on the public internet.

⚠️ **A DNS-capable token exists, and it is not wrangler's.** `downloads.pxkq.uk` was attached to
the `pnyx-releases` bucket on 2026-10-16 with the account token in
`~/.config/pnyx/cloudflare-token`, which carries `Zone:DNS:Edit`. ⚠️ Those tokens are
**IP-restricted and short-lived** — two were burned the same day: `1000 Invalid API Token` is
expiry, and `9109 Cannot use the access token from location: <ip>` is a changed egress address.
⚠️ Account-owned (`cfat_`) tokens verify at `/accounts/{id}/tokens/verify`, **not**
`/user/tokens/verify`, which calls a perfectly good one invalid.

⚠️ **No origin `cert.pem` exists on any host** — every tunnel here was created dashboard-managed.
That is worth keeping: a token-run connector cannot create or delete a tunnel, so a compromised box
cannot reshape the ingress. The cost is that **the DNS record is not automatable from here**: the
account's wrangler OAuth token carries zone *list* and no DNS scope, so neither the API nor
`cloudflared tunnel route dns` can write it. A new tunnelled hostname needs one proxied CNAME to
`<tunnel-id>.cfargotunnel.com`, from the dashboard or a token with `Zone:DNS:Edit`.

⚠️ **Set a keepalive on anything long-lived.** An idle WebSocket through a tunnel is not guaranteed
to survive, which is load-bearing for the indexer's subscriptions.

## Traps

- ⚠️ **Cloudflare replaces the body of any 5xx from a tunnel origin** with its own `error code: 502`
  page, so a genuine sponsor failure arrives with its account of what went wrong thrown away. The
  origin answers 200 with `ok: false` for a *sponsorship* failure for exactly this reason
  (`docs/SPONSOR_HOST.md`).
- ⚠️ **`wrangler r2 object put` without `--remote` writes local miniflare only** and reports success.
  Every publish to `pnyx-config` / `pnyx-artifacts` needs it.
- ⚠️ **`config.pxkq.uk` is served uncached** (`cf-cache-status: DYNAMIC`), so a broken control-plane
  file is live immediately. Parse what you uploaded before and after inserting a key.
- ⚠️ **A rate limit is per `CF-Connecting-IP`**, which is the user's NAT in practice. `POST /register`
  is the one unauthenticated route that spends sponsor DUST, so its limit is load-bearing.

## Not here yet

▶ **The token-holding proxy** (Blockfrost + SteelSwap keys, pay-as-you-go against the daily free
quota) is queued and undecided between the VPS, the Mac and the Pi. When it lands, its Cloudflare
side — the hostname and whether it fronts a Worker or a tunnel — belongs in this file.
