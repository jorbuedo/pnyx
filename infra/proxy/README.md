# The token-holding proxy

✅ **Built 2026-10-18.** One proxy in front of the credentialed APIs so **no key ever reaches a
client build**. **SteelSwap is the one that matters** — its partner key is published in a
world-readable config today and we cannot rotate it ourselves. Blockfrost's Midnight indexers come
next, a key per network, spending a free daily quota before a paid one.

⚠️ **Koios is deliberately NOT proxied** (dev-lead call, 2026-10-18). Its token buys the
authenticated rate tier and nothing else — unset means the anonymous tier — so it is neither a
billed account nor a fee-attribution principal, which is what the other two are. It stays in the
app's env.

Why it matters: anything the app reads is **bundled and public to that build's users** — the env
manifest has said exactly that about the Blockfrost project id and the SteelSwap partner key for
months. A proxy is what makes a paid key safe to hold at all.

| | |
|---|---|
| source | [`src/`](src/) — Rust, ~600 lines, 3.3 MB binary |
| config | [`proxy.example.toml`](proxy.example.toml) → `/etc/pnyx-proxy/proxy.toml` |
| secrets | [`secrets.example.env`](secrets.example.env) → `/etc/pnyx-proxy/secrets.env`, mode 0600 |
| unit | [`pnyx-proxy.service`](pnyx-proxy.service) |
| deploy | [`push.sh`](push.sh) — `PROXY_SSH=user@<host> infra/proxy/push.sh` (builds on the box) |
| sizing | [`bench/`](bench/) and the measurements below |

⏸ **Not yet deployed: the box is chosen (the VPS) but this repo cannot reach it** — the host is
deliberately not committed, and `push.sh` takes it as `PROXY_SSH`.

## What it does

Clients call unauthenticated paths; the proxy adds the credential and forwards.

| client calls | goes to | credential |
|---|---|---|
| `/swap/*` | `devapi.steelswap.io` | `Bearer`, the partner key |
| `/midnight/mainnet/*` | our self-hosted indexer | none, on purpose |
| `/midnight/preprod/*` (HTTP **and** `/ws`) | `midnight-preprod.blockfrost.io` | `project_id` |
| `/healthz` | answered locally | per-key usage counters |

⚠️ **A Blockfrost `project_id` belongs to one network**, so each Midnight network gets its own
credential block rather than sharing one — reusing another network's key just 403s. Adding
mainnet or preview later is that pattern again plus its secret, with no app release: the app
already reaches every network through this one path.

Verified end to end against a local upstream that echoes what it received:

- the credential is injected as a **header**, and the path prefix is rewritten
- a client-supplied `project_id:` / `authorization:` header is **stripped, not forwarded** — a
  caller cannot override the key or spend one we are not counting
- `?project_id=` is **stripped from the query string**, so a credential cannot re-enter a URL
- the free key is spent to its quota and then the paid key takes over, logged once at the switch
- a keyless route sends no credential at all
- **the WebSocket relays, and the upstream sees the credential as a header** from a client that
  sent none

Then driven against the **real** upstreams, not just the echo server (2026-10-18):

| route | result |
|---|---|
| `/swap/tokens/icon/lovelace/` | 200, partner key injected as `Bearer` |
| `/midnight/mainnet` | our own indexer, keyless: `{"data":{"block":{"height":3068208}}}` |
| `/midnight/preprod` | Blockfrost GraphQL: `{"data":{"block":{"height":3035353}}}` |
| `/midnight/preprod/ws` | **real subscription: `connection_ack` over `graphql-transport-ws`** |

(The `Bearer` path was additionally exercised against live Koios before that route was dropped, so
the prefix mechanism SteelSwap uses is proven against two upstreams.)

### And from the app, on the emulator (2026-10-18)

The dev variant built with `PNYX_LAN_HOST=10.0.2.2` and
`EXPO_PUBLIC_CARDANO_STEELSWAP_URL=http://10.0.2.2:8787/swap` (the emulator reaches the host's
loopback at `10.0.2.2`, and `with-lan-cleartext` permits cleartext to that host only). The Wallets
tab rendered balance, assets and transactions normally, and the app's own `dev-fetch` log shows:

```
POST http://10.0.2.2:8787/swap/api/v2/tokens/metadata          status 200
GET  http://10.0.2.2:8787/swap/api/v2/tokens/list?limit=200&cursor=…&sort=liquidity&verifiedOnly=true
```

14 requests, **zero proxy errors**, and the proxy logged one `now spending STEELSWAP_API_KEY`. The
pagination query survives intact, which is the other half of `clean_query`: it strips `project_id`
and nothing else.

⚠️ **This proves the app↔proxy path, not a deployment.** `10.0.2.2` is the host loopback seen from
one emulator. `endpoints.swapApi` in remote config points the whole fleet at a URL, so retiring the
published key still needs a **publicly reachable** proxy.

⚠️ Both Midnight indexers are `/api/v4/graphql`, ours and Blockfrost's. An earlier draft of this
config used `/api/v0` from Blockfrost's docs and got an empty body from our own host, which answers
404 on every path but that one.

⚠️ **The WebSocket result removes a compromise rather than moving it.** A browser or React Native
`WebSocket` cannot set a header, which is why the app had to put `?project_id=` in the socket URL
(`app/src/services/midnight/indexer-auth.ts` explains the trade). A server can, so behind this the
client's socket URL carries no credential anywhere.

## ⚠️ Proxying concentrates the rate limit, and that is the new ceiling

Blockfrost limits **10 requests/second sustained with a 500 burst, keyed by the caller's IP**, and
the free Starter tier allows **50,000 requests per UTC day**. Behind a proxy the whole fleet is one
IP, so it is one bucket instead of one per user. The arithmetic that follows is the real constraint
on this design, and it is not the hardware:

⚠️ An earlier draft of this section did the arithmetic on the Cardano sync floor. That traffic
**no longer passes through here** — Koios is not proxied — so the live figure is Midnight only:
one durable subscription per active wallet plus its dust reads. Whether that subscription costs
one request or thousands is the open question below, which is precisely why the number cannot be
stated yet.

What holds regardless: the fleet is one IP and therefore one bucket, the burst is 500, and the
free tier is 50,000/day across whatever counts as a request. None of it is a reason not to proxy —
the alternative is a public key in every build — but all of it is a reason to buy the
pay-as-you-go tier before a fleet exists, and to keep our own indexer on the networks where we
have one.

## ▶▶ The question the proxy now answers itself

**Does Blockfrost meter a WebSocket subscription as one request, or per message?** It is
undocumented: neither the pricing page nor the Midnight docs mention WebSocket metering at all, and
our Midnight traffic is mostly one long-lived subscription per wallet, so the answer changes the
sizing by orders of magnitude.

`/healthz` counts what *we* sent. Comparing that against Blockfrost's dashboard over the same UTC
day answers it from production traffic rather than from guesswork — the counter was built partly to
be that instrument. Until it is measured, **assume per-message** and size the paid tier for it.

## What it has to carry, measured

Read off this repo's code and the live endpoints on 2026-10-15, because the load model is what
sizes the box and it is not guesswork:

| | measured | where |
|---|---|---|
| persistent connections per active wallet | **1** | `services/midnight/wallet/unshielded-live.ts` — the only durable subscription |
| transient connections per wallet | dust reads open a WS, collect, close | the four `fetch*` in `wallet/dust-indexer.ts` are one-shot, not live |
| Cardano HTTP floor | **one sync per 5 min** | `MIN_SYNC_INTERVAL_MS = 300_000` (`services/cardano/rail.ts`), discovery the same |
| a simple GraphQL query | **47 B up / 137 B down**, 96-186 ms | `midnight-mainnet.pxkq.uk`, 5 runs |
| an identity-row read | **~18 KB down** | there is no read-one-key query on Midnight: a contract's ledger is one blob (8,975 state bytes, hex on the wire) |
| Blockfrost preprod latency | **1.9 / 3.4 / 8.6 s** on three consecutive trivial queries; one contract-state query **>30 s** | s162, from the sponsor box |

So: **1-2 concurrent connections per active wallet**, small frames, and an upstream whose latency is
four orders of magnitude larger than anything the proxy itself does.

## What the proxy costs, measured

[`bench/`](bench/) is a minimal Rust relay in the shape this would actually deploy in — **behind a
Cloudflare Tunnel, so `cloudflared` terminates TLS and it listens plaintext on localhost**, exactly
like the sponsor host and the indexer box. Each connection is `tokio::io::copy_bidirectional`, which
is what a WebSocket passthrough *is* after the 101: two streams, no parsing. That makes it the
honest per-connection floor.

⚠️ **Measured on this workstation (x86_64). The Pi is aarch64 — re-run it there before deciding.**
That is what `bench/` is for.

```
binary                        614 KB (tokio only, LTO, panic=abort)
idle RSS                      3.1 MiB cold, 8.4 MiB after churn
per concurrent connection     17.0-17.2 KiB, linear from 1k to 20k
20,000 concurrent             343 MiB, 3.2% of one core
  (each writing a 120 B frame every 2 s, ~10k frames/s aggregate)
fresh-connection throughput   14,863 req/s at ~1.1 cores -> ~75 us CPU/request
memory on disconnect          fully released (back to 8.4 MiB)
```

**Reading that: hardware is not the constraint.** 1,000 active wallets is ~45 MiB and no measurable
CPU. 10,000 is ~350 MiB and still under one core. Even a Pi 4 would hold ~100k connections' worth of
proxy memory before RAM bound it.

⚠️ **The 17 KiB is a tunable, not a constant** — it is dominated by `copy_bidirectional`'s two 8 KiB
buffers. At 2 KiB each it is ~5 KiB/connection; measured frames are 137 B, so small buffers fit the
traffic, but an 18 KB row read would then loop a few times. Size the buffer to the traffic, not to
the default.

⚠️ **~75 µs/request is connect/accept/close syscalls, not proxy work.** With keep-alive to the
client and a pooled upstream connection, which is what both sides actually do, per-request cost is
the head rewrite: a `memchr` to the end of the headers plus a write. The figure is a floor for the
worst case, not a budget.

## The real constraint, and the question to settle first

Not CPU and not RAM: the **Blockfrost quota**, and one unknown decides the arithmetic.

▶▶ **Does Blockfrost meter a WebSocket subscription as one request, or per message?** Our Midnight
traffic is mostly a long-lived subscription per wallet. If a subscription is one request, the free
daily quota covers a large fleet and the paid tier is barely needed. If it is metered per message,
the same fleet burns the quota in minutes. **This changes the sizing by orders of magnitude and it
is not answerable from here** — it needs their docs or a measured test against a real key.

The second input is the free tier's actual daily request allowance, which should be read off their
current pricing rather than remembered.

⚠️ **Treat the Blockfrost spend as a production per-user cost, not a development one.** Mainnet is
our own keyless indexer *today*, but Blockfrost is wanted for mainnet as well in due course, and
**preprod is a network users can select in a production build** — so preprod traffic is not confined
to developers either. An earlier version of this file argued the opposite; it was wrong on both
halves. Size the quota for the fleet, not for the team.

## Where it runs: the VPS

Settled 2026-10-18. On the measurements all three candidates are oversized for the job, so the
decision was about **uptime and where a paid credential is comfortable**, not capacity:

| box | verdict |
|---|---|
| **The VPS** | ✅ **chosen.** Already the credential-holding box (the sponsor's keys), 24/7 in a datacentre, stable egress IP — which matters more than it looks, because Blockfrost's rate limit is keyed by that IP. |
| The Mac | ✗ `autorestart` is unsupported on Apple Silicon: a power cut leaves the app's API path dark until someone is home. |
| The Pi | ✗ a home uplink, and it is the public media origin. It has ~3 GB free since the crawl was fixed, so capacity is no longer the objection — reachability is. |

Reversible: it is one binary, one config file and one secrets file. Moving it is a `push.sh` at a
different `PROXY_SSH` plus a tunnel route.

## ✅ `/midnight/preprod` is LIVE (2026-10-19)

**Why it matters.** Preprod is the only Midnight network whose indexer needs a credential: mainnet
is ours and keyless, preview's public indexer is alive and keyless, and Midnight's own preprod
indexer answers **410 Gone** since 2026-10-09. Today the app only reaches preprod through
`EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD` in a **gitignored** `app/.env`, so it works on exactly one
machine. No shipped variant carries it and the control plane serves no endpoints, because the URL
carries a `project_id` and the remote config is a world-readable R2 file — publishing it there would
publish the key, which is the mistake the SteelSwap retirement just undid.

⚠️ **The WebSocket is the part only this proxy can fix.** A browser/RN `WebSocket` cannot set a
header, so a credentialled subscription has to put `?project_id=` in the socket URL. `relay_websocket`
handshakes upstream with the header instead, so the client's URL carries no credential at all. Any
other route to preprod leaves the live feed either unauthenticated or leaking the key.

### What is already done

- ✅ The route and credential block are in `proxy.example.toml`; the secret names
  `BLOCKFROST_MIDNIGHT_PREPROD_FREE` / `_PAID` are declared in `secrets.example.env`.
- ✅ **The header form is verified against Blockfrost** (2026-10-19): `project_id` as a header
  answers **200** (height 3,050,124); with no credential it answers **403 Missing project token**.
  So the route will authenticate as written.
- ⚠️⚠️ **A declared key whose secret is unset FAILS THE BOOT.** I claimed the opposite from reading
  `Keyring::build`, which does `filter_map` a missing secret — but `config.rs` validates the pair
  **before** the keyring is built and exits 1 with `needs secret …, which the secrets file does not
  set`. Reading the consumer and not the validator cost a **33-second outage** on 2026-10-19
  (17:52:14 → 17:52:47): the config declared `_PAID` ahead of its secret, the proxy crash-looped
  four times, and `/swap` and `/midnight/mainnet` went down with it. Declare one key per secret you
  actually hold, and add the secret first.
- ✅ **The route is already on the box** (2026-10-19): the credential block and `[[route]]` are
  appended to `/etc/pnyx-proxy/proxy.toml`, backed up alongside as `.bak-2026-10-19`. It parses
  (`tomllib`, routes `/swap`, `/midnight/mainnet`, `/midnight/preprod`), and it is **inert until a
  restart**, so the two working routes are unaffected meanwhile.
- ✅ `push.sh` now compares what each side **declares** -- route prefixes and credential names --
  rather than diffing text. The deployed config is a TRIMMED version of the example, so a textual
  diff is dirty by construction and would be ignored within a week; the declaration sets are stable
  and are what actually 404s when they disagree.

### What still needs the box

**Done.** The route, the credential block and the secret are all in place, and
`https://api.pxkq.uk/midnight/preprod` answers a block height. `/healthz` shows the credential with
one key, quota 50,000, and the usage counter moving. The secret itself was added by a person:
appending a credential to a file on the box is refused by the session's permission layer, which is
the correct boundary — everything else here was done from the session, and the key was not.

For reference, that was:

```sh
# 1. The credential. The value is the preprod Blockfrost project_id already in app/.env.
ssh <proxy-host>
printf '\nBLOCKFROST_MIDNIGHT_PREPROD_FREE=%s\n' '<project_id>' >> /etc/pnyx-proxy/secrets.env

# 2. Restart, and confirm the keyring loaded — /healthz reports a credential with no keys as
#    exhausted here rather than at the first user request.
systemctl restart pnyx-proxy && curl -fsS http://127.0.0.1:8787/healthz

# 3. Prove it from OUTSIDE the box.
curl -s -X POST -H 'content-type: application/json' \
  -d '{"query":"{ block { height } }"}' https://api.pxkq.uk/midnight/preprod
```

It is working when step 3 returns a height. ⚠️ If a declared secret is missing at restart the proxy
does not start at all and systemd crash-loops it, taking the other routes with it — see the boot
validation above. Check `systemctl is-active` rather than assuming, and `journalctl -u pnyx-proxy`
names the missing secret on the first line.

### ✅ The app, done 2026-10-19

`https://api.pxkq.uk/midnight/preprod` is published as preprod's indexer in `dev.json`,
`preview.json` and `prod.json` under `networks.midnight.preprod.endpoints.indexer`. Only that one
key changed in each file; `node`/`nodeWs` are untouched, because the public preprod RPC works and
the build already knows it.

Verified from the device, not inferred: the endpoint screen resolves preprod's default to the proxy
URL, its Test answers `block 3050393`, `/healthz` shows the key's counter moving, and the device
logs its own calls to `api.pxkq.uk/midnight/preprod`.

⚠️ Precedence is **user > remote > builtin**, and `EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD` feeds
*builtin* — so remote config outranks it and the local override is already inert. It is left in
place on purpose: it costs nothing and is the fallback if the control plane fails to load.

⚠️⚠️ **Do not remove `EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD` until the proxied path is verified from a
device.** The last credential migration was confirmed with the old path still live and broke preprod
for exactly that reason: the app's own gate ran before any data request, so the failure landed
upstream of anything the proxy could answer.

⚠️ And this route inherits the ceiling the section above describes: every user shares the VPS's
egress IP, and Blockfrost keys its rate limit to that.

## Deploying

```sh
# once, on the box
sudo useradd --system --no-create-home pnyxproxy
sudo mkdir -p /etc/pnyx-proxy
sudo install -m 0644 proxy.example.toml /etc/pnyx-proxy/proxy.toml   # then edit
sudo install -m 0600 secrets.example.env /etc/pnyx-proxy/secrets.env # then fill in
sudo chown -R pnyxproxy:pnyxproxy /etc/pnyx-proxy

# every time
PROXY_SSH=pnyxproxy@<host> infra/proxy/push.sh
```

⚠️ **It builds on the box, and the VPS is deliberately minimal** — it does not even run
`bun install`, so Rust is likely absent. `push.sh` checks first and stops with the fix rather than
a bare `cargo: command not found`; `PROXY_BOOTSTRAP_RUST=1` installs rustup into that user's home
(no root). Building there rather than shipping a binary is not a preference: a static musl build
would need an `x86_64-linux-musl-gcc` this workstation lacks (rustls' `ring` compiles C), and a
glibc binary built here would be linked against a newer glibc than a Debian/Ubuntu VPS carries —
which fails at exec time on the target, not at build time here.

Then give it a tunnel hostname (`infra/cloudflare/`) pointing at `127.0.0.1:8787`, and point the
fleet at it through the control plane — `endpoints.swapApi` and the Midnight indexer endpoints are
already remote-config fields precisely so this is an operation rather than a release.

⚠️ The proxy **refuses to start** if the secrets file is group- or world-readable, if a route names
a credential that is not defined, or if a credential names a secret the file does not set. All
three are the same failure — a request that would go out unauthenticated and come back 403, looking
like the upstream is broken.
