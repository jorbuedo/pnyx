# Deploying the sponsor host

What each file is for, and the order to use them in. The reasoning behind the split — why only the
sponsor wallet lives off Cloudflare, why there is no proof server, why it is not containerised — is in
[`docs/SPONSOR_HOST.md`](../../docs/SPONSOR_HOST.md).

Runs on a small Debian VPS behind a Cloudflare tunnel. 2 vCPU / 4 GB is comfortable: the binding
constraint is the sponsor wallet's cold sync, not steady state. What to verify once it is up:
`/health` 200 through the tunnel, `/internal/*` 401 without the bearer token, and `/auth/config`
reporting `chain.enabled: true`.

The reference deployment's own provider, region and box are not published; everything here is about
running your own.

## One box, three networks

```
cloudflared ──> 127.0.0.1:3400  sponsor-router.service     no wallet, no seed, no ledger, no state
                                  ├─ 3401  sponsor@preview.service
                                  ├─ 3402  sponsor@preprod.service
                                  └─ 3403  sponsor@mainnet.service
```

⚠️ **One process per network is forced, not chosen.**
`@midnight-ntwrk/midnight-js-network-id` keeps the network in a module-level mutable global and reads it
when a transaction is *built* — `midnight-js-contracts` calls `Transaction.fromParts(getNetworkId(), …)`.
Two wallets in one process therefore share one network id and the one that booted last decides what the
other stamps its balancing transaction with. There is no per-call override and no way to scope it.

⚠️ **The router takes 3400 because that is where the tunnel already points.** Adding a network changes
nothing on the Cloudflare side: the tunnel's ingress rule is remote-managed (`cloudflared tunnel run
--token-file`, no local `config.yml`), so it is the one part of this that cannot be configured from the
repo.

**Sizing, measured rather than assumed.** A synced wallet is **~358 MiB RSS** (the live preprod process
after two days; the doc below records ~390 MiB and a ~590 MiB cold-sync peak). Three of them plus the
router plus `cloudflared` is ~1.2 GiB of 3919 MiB, and a DUST snapshot is 135 KB of 118 GB free. Memory
is not the constraint. **CPU is**: a snapshot-less cold sync saturates one core for its whole duration and
there are two, so bring a cold network up on its own — and note that mainnet's dust depth is unmeasured,
so its first sync is the one unknown in this plan.

| | |
|---|---|
| `sponsor.env` | shared: the token, the origin, the sponsorship policy, the routing table |
| `sponsor.router.env` | the router's port and timeouts |
| `sponsor.<network>.env` | `MIDNIGHT_NETWORK`, its port, its DUST snapshot, its backlog, its transfer policy |

The wallet unit reads the shared file **then** the per-network one, so anything network-specific
overrides the shared value deliberately. One seed serves all three: the same mnemonic is a different
wallet on each chain.

**ssh to it by hostname, never by IP.** Only the hostname ends up in `known_hosts`, and a provider's
record is often IPv4-only — an IP-addressed `push.sh` then hits an unknown-host prompt, which in a
non-interactive rsync means either a failed push or a fingerprint accepted blind. The host itself is
never committed: `push.sh` takes it as `SPONSOR_SSH`.

| | |
|---|---|
| `bootstrap.sh` | run once on a fresh box, as root: bun, cloudflared, service user, directories, firewall |
| `sponsor@.service` | the templated wallet unit — one instance per network (`sponsor@preview.service`) |
| `sponsor-router.service` | the front door on 3400 |
| `sponsor.env.example` | the shared `EnvironmentFile`, annotated |
| `sponsor.<network>.env.example` | one per network, annotated |
| `sponsor.router.env.example` | the router's own |
| `closure.ts` + `specifiers.ts` (+ tests) | which files the host actually needs (~400 MB of a 22 GB `node_modules`) |
| `push.sh` | rsync that closure, verify it loads, restart the service |

## Why rsync and not git-clone-and-install

The box never runs `bun install`. A filtered workspace install under-installs the hoisting-sensitive
Midnight SDK, and a full one drags the entire React Native tree onto a host that renders nothing — the
same wall the containerisation attempt hit (`docs/SPONSOR_HOST.md`). So `closure.ts` walks the real
import graph from `sponsor-server.ts` and `push.sh` pushes only that, out of a `node_modules` bun has
already laid out correctly. Subsetting a working tree preserves its hoisting; reinstalling a subset does
not.

Type-only imports are excluded, which is what keeps the 41 MB `contract/managed` build output off a host
whose whole point is not depending on the deployed contract.

Verification is empirical rather than by inspection: after the transfer, `push.sh` runs the entry point on
the box. Every static import resolves before the module body executes, so a missing package fails there
with `Cannot find module` instead of at the next restart. With no `SPONSOR_TOKEN` in an ssh environment
it then exits immediately, before any wallet is constructed — safe against a live host.

**What that check does not cover:** it runs in an ssh session, not inside the unit's sandbox, so anything
`ProtectSystem=strict` / `ProtectHome` / `ReadWritePaths` would forbid still passes here. That is why
`push.sh` also watches the restarted unit for 30 s and compares `NRestarts` — `is-active` alone is useless,
since it exits 3 while a unit is `activating` and reports `active (running)` in the gap between two crashes
of a crash-looping service.

## Failure modes already found, so a rebuild does not rediscover them

- **`EROFS` crash-loop on first start.** Importing `@midnight-ntwrk/testkit-js` builds a pino logger at
  *module scope* that opens `logs/tests/<timestamp>.log` relative to the process CWD. With the code tree
  read-only that is an immediate crash, and it happens before any of our code runs, so no application-level
  setting can prevent it. Fixed by pointing `WorkingDirectory` at `/var/lib/sponsor` and giving `ExecStart`
  an absolute script path — bun resolves `node_modules` from the script's location, not from CWD, so
  `/opt/sponsor` stays read-only.
- **`StartLimitIntervalSec` is a `[Unit]` key, not `[Service]`.** systemd logs `Unknown key` and ignores it,
  leaving the default limit in force — so a wallet that could not reach chain would have been stopped out
  after five attempts, which is the opposite of the intent. Confirm with
  `systemctl show -p StartLimitIntervalUSec --value sponsor@preprod.service`.
- **Slow uplink dominates the first push.** Measured ~1 Mbit/s with an 18 s buffer-bloated RTT, which also
  makes *new* ssh connections time out while a transfer is running. `-z` gets an 8.6× speedup (39 MB on the
  wire for 340 MB of content). The cost really is one-time: a subsequent push of a one-line change measured
  835 bytes on the wire, a 405× speedup.
- **Cloudflare replaces the body of any 5xx a tunnel origin returns** with its own `error code: 502` page.
  The status survives; the explanation does not. This cost a long debugging detour: `/internal/register`
  answered a malformed transaction with a perfectly good `{"error":"…sponsorship refused: bytes are not a
  proven-unbound transaction…"}` at status 502, and every caller through the tunnel saw only
  `error code: 502` with `server=cloudflare`. It looked like a broken tunnel and was nothing of the kind —
  `POST /internal/submit` returning 202 through the same tunnel was the observation that broke the deadlock.

  So **never use a 5xx for a caller-fault rejection here.** A refusal is now classified with
  `isSponsorshipRefusal` and answered 400, whose body Cloudflare passes through untouched. Anything that
  hides a reason behind a 5xx will be invisible in production the same way.

  Still imperfect: the *Worker* wraps that 400 and returns 502 to the app. The reason now reaches the app
  inside the message, but propagating the status properly needs a typed error across the `ChainMirror`
  boundary rather than a status parsed out of a string — deliberately not refactored mid-deployment.
- **A provider image can ship a broken IPv6 default gateway**, and ours did:
  `/etc/network/interfaces.d/50-cloud-init.cfg` carried an address one colon out from the link-local
  router that actually answers. Nothing rejects it — the string is valid IPv6 syntax and the route
  installs `onlink`, so there is no boot error, only silent stalls wherever AAAA is preferred. It
  comes from the provisioning seed, so every box from that template has it. Check it with
  `ip -6 neigh` before trusting the rendered config.

  It did **not** block the tunnel; cloudflared picked IPv4 edge IPs on its own. Fix with
  `ip -6 route replace default via fe80::1 dev eth0 onlink`; persisting it also needs
  `network: {config: disabled}` in `/etc/cloud/cloud.cfg.d/`, since the seed is the source of truth.
- **A restart during the first cold sync is `SIGKILL`ed after 90 s and throws the sync away.** Measured, not
  theorised: it cost four wasted syncs during the first bring-up. `sponsor-server.ts` registers no `SIGTERM`
  handler, and while the cold sync saturates the process it never services the signal, so systemd hits
  `TimeoutStopSec` and the journal reads `Failed with result 'timeout'`. The dust snapshot is only written
  once `waitForSections` returns (`sponsor-client.ts`), so everything up to that point is lost.

  **So do not `push.sh` while the first sync is running** — it restarts the unit. Wait for
  `dust-state.preprod.gz` to appear in `/var/lib/sponsor`.

  **Once synced, restarts are clean and fast** — `Deactivated successfully`, no timeout, `/health` answering
  again 12 s later off the snapshot. The default SIGTERM disposition is enough for an idle process; only the
  sync-saturated one blocks. A `stop()` on `sponsor-client` that drains the queue would still be an
  improvement — an in-flight submit is cut short today — but it is not the every-restart tax it first looked
  like, and the backlog covers anything already accepted.

## Rotating the seed

The seed file is the wallet. Replacing it makes this host a different sponsor, so the dust snapshot has
to go with it and the new wallet has to be funded before it can pay for anything —
`docs/SPONSOR_HOST.md` has the reasoning.

⚠️ **One seed serves every network, so a rotation rotates all of them at once.** Every snapshot has to go
and every network pays a cold sync; there is no per-network seed to change on its own.

```bash
# 1. The new phrase, from stdin. Nothing else on the box changes.
ssh root@<host> 'install -o sponsor -g sponsor -m 0600 /dev/stdin /etc/sponsor/sponsor-seed'

# 2. Every dust snapshot belongs to the OLD wallet's dust key. Each deletion costs one cold sync.
ssh sponsor@<host> 'rm -f /var/lib/sponsor/dust-state.*.gz'

# 3. Restart one network at a time and confirm which wallet came up — in the JOURNAL, not over HTTP.
#    The address is the assert; `active (running)` proves only that exec succeeded. Serially, because
#    three cold syncs on two cores is the one case worth being careful about.
for n in preprod preview mainnet; do
  ssh sponsor@<host> "sudo systemctl restart sponsor@$n.service"
  ssh sponsor@<host> "journalctl -u sponsor@$n.service -n 5 --no-pager | grep 'sponsor wallet'"
done
```

Nothing answers on the port for the ~35 min the fresh dust sync takes (see `docs/SPONSOR_HOST.md`), and
**restarting during it loses the sync**, so do not push again until `dust-state.<network>.gz` appears.
Once it does, `/status` reports the wallet's `address` too.

Until the new address holds NIGHT, `/status` reports `failing` with *DUST is exhausted* and every
sponsorship fails. That is the honest answer, not a bug: fund the address, and boot's `ensureDust`
registers it for dust generation on its own.

## First run

```bash
# 1. Some providers only inject an ssh key during an image install; on a running box add it yourself.
ssh-copy-id root@<host>

# 2. Prepare the box. Installs everything, creates the sponsor user, closes the firewall to ssh-only,
#    installs both units and retires the old single-network one.
scp infra/sponsor-host/{bootstrap.sh,sponsor@.service,sponsor-router.service} root@<host>:/tmp/
ssh root@<host> 'bash /tmp/bootstrap.sh'

# 3. The seed — a BIP-39 mnemonic (a hex master seed still works, but the app can never open one).
#    Read from stdin so the phrase reaches no shell history, no argv and no log. ONE seed for every
#    network: the same mnemonic is a different wallet on each chain.
ssh root@<host> 'install -o sponsor -g sponsor -m 0600 /dev/stdin /etc/sponsor/sponsor-seed'

# 4. The environment: the shared file, the router's, and one per network you serve.
#    Fill in SPONSOR_TOKEN first: openssl rand -hex 32
scp infra/sponsor-host/sponsor.env.example root@<host>:/etc/sponsor/sponsor.env
scp infra/sponsor-host/sponsor.router.env.example root@<host>:/etc/sponsor/sponsor.router.env
for n in preview preprod mainnet; do
  scp infra/sponsor-host/sponsor.$n.env.example root@<host>:/etc/sponsor/sponsor.$n.env
done
ssh root@<host> 'chown sponsor:sponsor /etc/sponsor/sponsor*.env && chmod 0600 /etc/sponsor/sponsor*.env'
ssh root@<host> 'vi /etc/sponsor/sponsor.env'

# 5. The proving keys. Balancing proves (see below), and this host runs no proof server, so the four
#    wallet circuits' keys have to be on disk. ~33 MB, fetched by the box itself, once per box.
#    Contract- AND chain-independent, so one directory serves every network.
SPONSOR_SSH=sponsor@<host> infra/sponsor-host/fetch-prover-keys.sh

# 6. Push the code and verify it loads. push.sh restarts whatever is installed and skips what is not.
SPONSOR_SSH=sponsor@<host> infra/sponsor-host/push.sh

# 7. Enable the router, then ONE NETWORK AT A TIME. A snapshot-less cold sync saturates a core and
#    there are two — so wait for each to report `ok` before starting the next.
ssh sponsor@<host> 'sudo systemctl enable --now sponsor-router.service'
ssh sponsor@<host> 'sudo systemctl enable --now sponsor@preprod.service'
ssh sponsor@<host> 'curl -s localhost:3400/health | jq'     # repeat until preprod reads ok
ssh sponsor@<host> 'sudo systemctl enable --now sponsor@preview.service'
ssh sponsor@<host> 'sudo systemctl enable --now sponsor@mainnet.service'

# One network's log. The identifier is per instance, so this is one chain's story:
ssh sponsor@<host> 'journalctl -fu sponsor@preprod.service'
```

⚠️ **A wallet with no DUST never finishes starting, and that is the intended state for mainnet before
NIGHT is delegated.** `ensureDust` polls every 10 s for a non-zero DUST balance rather than failing, so
the unit sits at `503 {status: 'starting'}` indefinitely and comes alive by itself the moment DUST
appears. It is not a crash loop and there is nothing to retry — `/health` will report that network
`starting` until then, and the router refuses to route to it by name.

⚠️ **Balancing is a proving path, and forgetting the keys fails only on a real transaction.** `balanceTx`
adds the sponsor's own unproven zswap/dust spends, so the facade proves them. Without
`CHAIN_PROVER_KEYS_DIR` the SDK dials `PROOF_SERVER_URL` (default `127.0.0.1:6300`) and a registration
dies as `Failed to prove transaction` — while `/health` stays green and a garbage-bytes probe still
returns a correct 400, because the policy refuses those before anything balances. A probe that never
reaches `balanceTx` cannot test this; only a real device-proven transaction can. Full story in
`docs/SPONSOR_HOST.md`.

The deploy user has no password and is not in the `sudo` group. `bootstrap.sh` gives it a scoped
`NOPASSWD` entry for exactly those five unit actions and nothing else, plus `systemd-journal` membership
so it can read its own logs.

⚠️ **Do not skip the `enable` in step 7.** `bootstrap.sh` installs the units but deliberately leaves them
disabled, because the seed and environment are not in place yet — and `push.sh` only ever *restarts*, so it
will never enable one for you. A box that was only ever `start`ed looks perfectly healthy until it reboots
and comes back with cloudflared up and nothing behind it. Check every unit at once:

```bash
ssh sponsor@<host> 'systemctl is-enabled sponsor-router.service sponsor@{preview,preprod,mainnet}.service'
```

The first boot pays the preprod dust cold sync: measured on this host at **34:36**, one core saturated, ~590
MiB RSS peak (settling to ~390 MiB once synced). It writes the snapshot when it finishes, after which a
restart is back up in ~12 s.

**`/health` answers throughout that sync** (changed 2026-08-15; it previously did not answer at all, because
`Bun.serve()` ran after the top-level `await createSponsorClient(...)`). It returns `503 {ok: false, status:
'starting'}` until the sections are up, then `200 {ok: true, status: 'ok'}` — so it *is* usable as a startup
probe now, and a refused connection means the process is gone rather than busy. Needs no token.

`GET /status` is the diagnostic one and **does** need the bearer token, because it reports balances. It adds
what a liveness check cannot see: per-section sync completeness and lag, DUST and NIGHT balances, unobserved
own-spends, submission counters, and the last failure. Its `status` field is one of `starting | ok | degraded
| failing`, so a checker needs none of the rules:

```bash
curl -s -H "authorization: Bearer $SPONSOR_TOKEN" localhost:3400/status | jq
```

`failing` means it cannot sponsor anything — the wallet never started, or DUST is exhausted. `degraded` means
it is still serving but something is wrong: a section behind, the optional `SPONSOR_DUST_FLOOR` crossed, a
backlog that has not drained, or nothing succeeding since the last failure. That last rule is the only thing
that catches the missing-prover-keys class above, where every cheap probe stays green.

The origin aggregates it at `https://pnyx.pxkq.uk/status` — unauthenticated, states and reasons only, no
balances. Open it in a browser for a page, or `Accept: application/json` for a checker. It answers even when
this box is down, reporting `sponsor: unreachable`, which is the point of putting it there.

## The tunnel

**Dashboard-managed**, chosen deliberately: the locally-managed alternative needs `cloudflared tunnel
login`, which leaves an account-scoped `cert.pem` on a host holding wallet funds. That is a bad trade for
version-controlling one hostname mapping, especially since the part of this box worth reproducing — the
runtime tree — is already scripted. So the routing is recorded here rather than in a config file:

| | |
|---|---|
| tunnel | created in Zero Trust → Networks → Tunnels |
| public hostname | `sponsor.pxkq.uk` |
| service | `http://127.0.0.1:3400` |
| edge | QUIC, 4 connections, IPv4 edge IPs |

`bootstrap.sh` already installs cloudflared, so only the connector registration is left:

```bash
cloudflared service install <token>       # as root; no sudo needed
```

**If that reports a start timeout**, check whether it actually wrote the token. Observed once: the unit was
generated with `ExecStart=… tunnel run --token-file /etc/cloudflared/token` while `/etc/cloudflared/` was
left empty, so the service crash-looped on `Failed to read token file`. Write it yourself — `read -rs` keeps
the token out of shell history and off the process list:

```bash
read -rs CF_TOKEN && printf '%s' "$CF_TOKEN" | install -m 600 -o root -g root /dev/stdin /etc/cloudflared/token \
  && unset CF_TOKEN && systemctl start cloudflared
```

Then add the public hostname in the dashboard, which also creates the CNAME. Until it exists,
`sponsor.pxkq.uk` does not resolve at all — a connected connector is not by itself an ingress.

Then point the Worker at it:

```bash
cd services/content
bunx wrangler secret put SPONSOR_TOKEN      # the same value as /etc/sponsor/sponsor.env
bunx wrangler secret put SPONSOR_URL        # https://sponsor.pxkq.uk
bunx wrangler deploy
```

`/auth/config` should flip to `chain.enabled: true`, and `/register` + `/chain/submit` stop answering 503.

### Worth doing next: take the hostname off the public internet

A tunnel public hostname is internet-reachable. The bearer token is the only thing in front of the
wallet, and `/health` requires none. Since the Worker is the sole client, a Cloudflare Access policy
with a service token in front of `sponsor.pxkq.uk` removes the public surface entirely — the Worker then
sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` alongside the bearer token. Free tier covers it.

## Live since 2026-08-28, and what the first run found

Cut over from the single preprod unit with no Cloudflare-side change: the router took 3400, preprod
moved to 3402, then preview and mainnet started.

| | |
|---|---|
| preprod | `ok`, 35.6 DUST, same wallet (`mn_addr_preprod1g84s5k7…`), synced from its snapshot in **5 s** |
| preview | `ok`, DUST generated from the 1 NIGHT that had landed at its address earlier the same day |
| mainnet | `starting` — no DUST until NIGHT is delegated, which is the designed state |
| memory | **1510 MiB of 3919 with two cold syncs in flight**; the router is **43 MiB** |

⚠️ **Three things the first run found that no test could have.**

1. **The router's probe budget has to fit inside its caller's.** A cold-syncing wallet is CPU-starved
   enough to miss a 5 s deadline on its own synchronous `/health`, and at a 5 s probe timeout one such
   network spent the content service's whole budget — so the public status page read `failing` while
   preprod was serving perfectly. Now 2 s, and a timeout reads as *busy or still starting* rather than
   *unreachable*.
2. **`SPONSOR_UNITS=` has to mean "restart nothing".** `${VAR:-default}` treats an empty value as unset,
   so a cutover push started the router on a port the old unit still held. It is `${VAR-default}` now.
3. **Read a value before you overwrite the file you read it from.** The one-off script that split
   `sponsor.env` per network took `SPONSOR_FUND_TRANSFERS` *after* replacing that file, so preprod came
   up with transfers silently unfunded. Caught only because the service logs its policy on the happy
   path — `plain transfers are not funded` — which is the whole argument for logging a success.

## Adding a network to a live host

Nothing on the Cloudflare side changes, and no other network is touched.

```bash
# 1. Its env file, and the routing table.
scp infra/sponsor-host/sponsor.<net>.env.example root@<host>:/etc/sponsor/sponsor.<net>.env
ssh root@<host> 'chown sponsor:sponsor /etc/sponsor/sponsor.<net>.env && chmod 0600 /etc/sponsor/sponsor.<net>.env'
ssh root@<host> 'vi /etc/sponsor/sponsor.env'          # add <net>:<port> to SPONSOR_NETWORKS

# 2. The router has to re-read the table; the wallets are untouched by this.
ssh sponsor@<host> 'sudo systemctl restart sponsor-router.service'

# 3. Start it, on its own — a cold sync saturates a core.
ssh sponsor@<host> 'sudo systemctl enable --now sponsor@<net>.service'
ssh sponsor@<host> 'journalctl -fu sponsor@<net>.service'
```

⚠️ **Pick an unused port.** `SPONSOR_NETWORKS` refuses the router's boot on a duplicated port or a
duplicated network rather than serving a subset — two networks on one port would route one chain's
transaction to another chain's wallet, which is the exact failure this topology exists to prevent, and it
would look like a working deployment.

⚠️ **The wallet also refuses a foreign transaction before accepting it**
(`services/content/src/sponsor-network-guard.ts`), so a mis-set `SPONSOR_NETWORKS` produces a named 400
rather than a 202 followed by silence. That guard is one-sided by construction: the absence of a
network's name in the bytes is proof, its presence is not, and the ledger keeps the last word at balance
time.

## Which networks are actually up

```bash
# Unauthenticated, cheap, per network — this is the one to reach for first.
ssh sponsor@<host> 'curl -s localhost:3400/health | jq'

# Behind the token: balances, sync lag, backlog, last failure, per network.
ssh sponsor@<host> 'curl -s -H "authorization: Bearer $(sudo grep -oP "(?<=^SPONSOR_TOKEN=).*" /etc/sponsor/sponsor.env)" localhost:3400/status | jq'
```

⚠️ **`ok` on the router means every configured network is live.** Two of three is `degraded`, and the
public `/status` page names each one and its own word — including the ones that are fine. A report that
listed only problems read identically to a host that had quietly stopped serving a network, which is how
`sponsor: ok` hid a preview outage on 2026-08-28 while every preview submission was refused inside
`balanceTx`.

## Updating

```bash
SPONSOR_SSH=sponsor@<host> infra/sponsor-host/push.sh
```

Pass `--wipe` after dropping a dependency: rsync cannot prune against a `--files-from` manifest, so stale
packages otherwise linger. Harmless, but the point of the closure is knowing what is on the box.

**A contract redeploy does not need a push, and no longer needs a config change either** — nothing here
depends on the contract module or the ZK artifacts, and neither `IDENTITY_CODE_DIGEST` nor
`CIRCLE_CODE_DIGEST` is a deployment value. Both recognise a *template* by its compiled code, which is
what makes them survive every deploy: there is one contract per circle and one per identity, so no
address could be configured in the first place (`docs/SPONSOR_HOST.md`).

Update a digest when its `.compact` is **recompiled**, from the artifacts manifest for the same build:
`curl -s https://artifacts.pxkq.uk/<identity|circle>/manifest.json | jq -r .codeDigest`.

⚠️ `IDENTITY_CONTRACT_ADDRESS` was retired on 2026-08-25 with the per-identity contract; a sponsor still
configured with it fails to boot (the variable is required and gone).

⚠️ **`MIDNIGHT_NETWORK`, `PORT`, `CHAIN_DUST_STATE_FILE` and `SPONSOR_BACKLOG_FILE` left `sponsor.env` on
2026-08-28.** They are per network now and live in `sponsor.<network>.env`. A host still carrying them in
the shared file gives every wallet the same port and the same DUST snapshot — the second to boot fails on
`EADDRINUSE` and the first resumes a state belonging to another chain.
It also needs the artifacts re-uploaded to R2, which is a separate rail.
