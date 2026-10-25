# Self-hosted Midnight indexer

Midnight's official **mainnet indexer** was decommissioned at 22:00 UTC on 2026-09-30.
`indexer.mainnet.midnight.network` is NXDOMAIN. Blockfrost is the named successor, and its free
tier is one project — and a project is per network — on a **daily request quota shared across the
whole plan**, i.e. across every user of the app, not per user. That is not a wallet backend. This
directory is the alternative: we run the indexer ourselves.

## What still answers, measured 2026-10-01

| endpoint | state |
|---|---|
| `indexer.mainnet.midnight.network` | gone (NXDOMAIN) |
| `rpc.mainnet.midnight.network` (http + **ws**) | **alive**, `"Midnight Mainnet"`, head 2,821,197 |
| `indexer.preprod.midnight.network` | alive, head 2,787,790 |
| `rpc.preprod.midnight.network` (http + ws) | alive |
| `midnight-{mainnet,preprod}.blockfrost.io` | `403 Missing project token` |
| `rpc.ankr.com/midnight_{mainnet,testnet}` | alive, free, keyless, **HTTP only — no WebSocket** |

Only the indexer host died; the node RPC did not, whatever the migration runbook says. That is what
makes this directory possible, and it is also the single point of failure: the indexer walks the
chain over `APP__INFRA__NODE__URL`, and Ankr cannot stand in because the chain-indexer subscribes
over WebSocket.

## Why no node of our own

`midnight-node` refuses to start without a Cardano db-sync Postgres:

```
db_sync_postgres_connection_string must be defined if ariadne is enabled
(i.e. if use_main_chain_follower_mock is false)
```

Midnight is a Cardano partner chain; committee selection (Ariadne) reads the main chain. The mock
follower is for dev chains — with an empty registration set it panics in
`partner-chains/toolkit/data-sources/mock/src/candidate.rs:227`, and a fabricated committee would
not match mainnet's anyway. A real node therefore means a Cardano node **plus** db-sync plus
Postgres: IOG's mainnet db-sync snapshot alone is 81 GB compressed, restoring to several hundred.
Cardano *preprod* db-sync is a fraction of that, so a preprod node is the cheap case if we ever
want one.

## Initial sync is the whole problem, and it is not the data

The chain is small: ~2.82 M blocks, ~3.5 GB of block bodies. The sync takes days anyway, because
`chain-indexer`'s catch-up is a sequential conversation. Measured through a counting proxy, it
asks the node **~18 JSON-RPC calls per block** (`archive_v1_hashByHeight`, `archive_v1_header`,
`archive_v1_body`, ~5 `archive_v1_call`, `archive_v1_storage`/`stopStorage`, plus the SPO trio when
that task is deployed) and waits for each. At ~50 ms RTT to the public RPC (AWS Dublin) that is
~51 million round trips, and the link idles at 0.1-2 KiB/s throughout.

```
measured from a home connection, public mainnet RPC:
  indexer sync rate              2.5 blocks/s     → ~16 days      (link idle, CPU ~2%)
  parallel fetch, concurrency 1    8.8 blocks/s
  parallel fetch, concurrency 16  131 blocks/s
  parallel fetch, concurrency 64  518 blocks/s
  parallel fetch, concurrency 128 875 blocks/s    → ~54 min       (zero failures)
```

The same server, the same house, the same bytes: 350x faster when the questions overlap. Nothing
about the chain size or the bandwidth is the constraint — only the one-at-a-time conversation.
Blockfrost's quoted ~67 minute preprod sync is this same code at sub-millisecond RTT.

**The fix, built and measured: `readahead-proxy.ts`.** It keeps the indexer's sequential
conversation and answers it from a cache filled by parallel upstream requests. The per-block
request set turned out to be a fixed template parameterised only by the block hash (one
`hashByHeight`, two `header`, one `body`, four `call`, one `storage` operation), so prefetching is
mechanical; templates are also learned at runtime, so a runtime upgrade that changes the call set
costs one slow block rather than breaking the proxy.

```
                      blocks/s   hit rate   mainnet ETA
direct to public RPC       2.5          -       16 days
through the proxy          176      99.6%      ~4.4 hours   ⚠️ early-height only, see below
```

Measured over a 180 s window at depth 96 with 8 upstream connections: 0 prefetch failures, 0
state-root mismatches, 0 restarts, chain-indexer at ~20% CPU and the proxy at ~18%. Seven sampled
block hashes (1, 2, 1 000, and four spread to the tip) were verified **against the public RPC
directly, not through the proxy**, and all matched.

⚠️ **That 176 blocks/s does not hold, and the ETA from it is wrong by an order of magnitude.** It
was measured over 180 s at low height. The real walk, started 2026-10-01 11:03 UTC against mainnet,
decays hard as ledger state grows:

```
height      rate        note
   250k     ~90k/h      the first 200k blocks go in ~1 hour and mean nothing
   900k     ~61k/h
  1.68M     ~28k/h      measured 2026-10-02 22:25 UTC, 59% of a 2.84M tip
```

Budget **two to three days**, not 4.4 hours, and do not extrapolate an ETA from the early hours.
Postgres was 55 GB at 927k blocks and 100 GB at 1.68M, so a full mainnet walk wants ~170 GB against
the VM's 600 GB disk.

⚠️ **By 1.68M the bottleneck is no longer the one this proxy was built to fix, and it is not the
box either.** Measured on the host at that height: the podman VM 99% idle with zero I/O wait,
`chain-indexer` at 3.5% CPU, Postgres at 3.2%. The indexer log is bursts of ~20 blocks 5.5 ms apart
separated by **~4.5 s stalls** — waiting on upstream, not computing. The proxy's own concurrency is
what binds: `PNYX_PREFETCH_DEPTH` is 96, but the pump is bounded by `running < INFLIGHT / 8` = **32
concurrent**, which pins the warm window at ~50 blocks ahead (observed `prefetchTop - cursor` of
46-62, never near 96). Raising `PNYX_MAX_INFLIGHT` / `PNYX_UPSTREAM_CONNS` is the lever; the cost is
upstream rate-limiting, and restarting the proxy costs an indexer restart.

✅ **That lever only works once the miss path has sockets of its own — 2026-10-11, 3,850 → 32,300
blocks/h (8.4x).** By 2.34M the walk had decayed to 3,850 blocks/h with every resource idle: upstream
RTT **53 ms flat** on a fresh socket, 98.5% cache hits, Postgres at 7 commits/s, the VM 100% idle,
and all 20 `chain-indexer` threads parked in `futex_do_wait`. The cause was **head-of-line blocking
in this proxy**: `nextUpstream()` round-robined the same `PNYX_UPSTREAM_CONNS` sockets for both
prefetch and cache misses, and prefetch keeps `INFLIGHT / 8` heights × ~12 calls in flight. A miss
is the *only* call the indexer blocks on, so it was waiting seconds for a 53 ms request queued
behind prefetch work nobody was waiting on. `PNYX_MISS_CONNS` (default 2) now gives the miss path a
dedicated pool. Measured per-call latency fell to ~55 ms, i.e. true RTT, and the walk went to
**6.9 blocks/s**; raising prefetch concurrency on top (`PNYX_UPSTREAM_CONNS=16`,
`PNYX_MAX_INFLIGHT=1024`, `PNYX_MISS_CONNS=3`) lifted the hit rate 0.767 → 0.84 and the rate to
**9.0 blocks/s**, with zero prefetch failures. ⚠️ Raising prefetch concurrency *before* isolating
the miss path would have made things worse, which is why the advice above stood unused for a week.

⚠️ **Misses are now the binding constraint, not latency.** `missMs` saturates the 30 s window
(~24-30 s of it), so throughput is `misses/block × RTT`. The remaining win is covering more of the
per-block call set in the prefetch template, not more sockets.

**The two instruments that decompose the wall clock** are in the 30 s `readahead` line: `missMs` /
`missMax` (time the indexer spent blocked on us) and `idleMs` / `idleMax` (time we spent waiting for
the indexer to ask again), plus `slowest`, the three methods by total miss time. Whichever of
`missMs` and `idleMs` dominates owns the stall — that one comparison is what settled this, after
three days of guessing at per-method miss counts.

```sh
PNYX_UPSTREAM_WS=wss://rpc.mainnet.midnight.network PNYX_PROXY_PORT=9999 \
  PNYX_UPSTREAM_CONNS=16 PNYX_MAX_INFLIGHT=1024 PNYX_MISS_CONNS=3 \
  bun infra/midnight-public/readahead-proxy.ts
# then point the stack at it: APP__INFRA__NODE__URL=ws://host.containers.internal:9999
```

⚠️ **`pgrep -f "bun readahead-proxy.ts"` does not match an absolute-path launch**, so the guard in
`bin/start.sh` used to start a second proxy that died on `EADDRINUSE` while the first kept running.
Match on `readahead-proxy.ts` alone, and kill by pid rather than by that pattern.

✅ **It IS out of the mainnet path, since 2026-10-15.** `bin/repoint-node.sh
wss://rpc.mainnet.midnight.network` moves `pnyx-chain-indexer-mainnet` onto the upstream directly,
and `bin/start.sh` then launches no proxy — it reads the container's own `APP__INFRA__NODE__URL`
rather than a constant, so boot follows whichever way the container is pointed. Use the proxy for a
catch-up walk and take it out at the tip; the reasons are all measured, not argued:

- **It costs 21 GB.** `footprint -p <pid>` read **21 GB (peak 26 GB)** after 4 d 7 h, of which
  15.7 GB was compressed out — the whole of the host's 14.2 GB of swap. ⚠️ **`ps -o rss` said
  5.8 GB**, understating it 4x, and wandered 5.8 → 3.7 GB in six minutes while `vmmap -summary`'s
  `written=` stayed flat. Measure this with `footprint` or `vmmap`, never `ps`. The containers were
  innocent throughout (~2.1 GB for all five) and so was the podman VM (16 GB = its assignment,
  peak == current). Cause and fix: `MAX_LEARNED_TEMPLATES` in `readahead-proxy.ts`.
- **Tip-following gains nothing.** One block per 6 s, and `hits` froze the moment the walk ended.
- **It converts an upstream blip into an indexer problem.** On 2026-10-15 00:20-00:35 the upstream
  was unreachable, the indexer could not even fetch `rpc_methods`, and `restart: unless-stopped`
  crash-looped it with no backoff: **9,178 of the proxy's 9,180 lifetime client connections landed
  in that one hour.** Its own subxt client reconnects natively with backoff instead.
- **Pass-through is the path it understands least.** During catch-up the indexer issued 36
  `chainHead_v1_call`s that came back `-32801 Invalid block hash` — it carried on at full speed and
  logged nothing. ⚠️ Related limit worth knowing: the upstream caps `chainHead_v1_follow` at **4 per
  connection** (`-32800 Maximum number of chainHead_follow has been reached`, verified directly),
  and the proxy keeps one upstream socket per client and never unfollows.

⚠️⚠️ **This proxy has leaked upstream sockets three separate ways, and a leak here takes down the
whole LAN, not just the walk.** Bun leaves an errored socket in ESTABLISHED with no close frame, so
anything that forgets one pins a NAT entry in the router in front of it. On 2026-10-04 that reached
3,652 sockets from a pool configured for 8 and exhausted the router's connection-tracking table:
every new flow on the house network dropped (DNS timing out against every resolver, TCP connect at
7.2 s from three SYN retransmits) while established flows stayed at a flat 9 ms RTT. Killing the
process took measured loss from 55% to 0%.

The three, all fixed:

1. **`connect()` rejected without closing** — one orphan per failed retry, against 12,730 logged
   prefetch failures. Every exit from the promise now closes the socket, and a connect that never
   reaches OPEN is closed after `PNYX_CONNECT_TIMEOUT_MS` (default 15 s).
2. **`onclose` cleared state it no longer owned** — `discard` can reconnect before a closing
   socket's `onclose` fires, and that handler then cleared `this.ws`/`this.ready` pointing at the
   *new* socket, orphaning it OPEN with nothing referencing it. One per upstream error, on the
   normal path after any error. `onclose` is now guarded on socket identity and logs
   `stale upstream closed, keeping live socket`.
3. **The pass-through `Upstream` was never closed** — `websocket.open` builds one per client and
   `close` only logged, so every client reconnect orphaned one. The indexer reconnects on every
   restart, and the block-1788980 crash loop restarted it 24,057 times in 24 h. `Upstream.close()`
   exists now and the server's `close` calls it.

**The standing instrument** is the `sockets` field in the 30 s `readahead` log line: upstream
sockets constructed minus released. That is *intent*; the truth is
`lsof -nP -p $(pgrep -f 'bun readahead-proxy.ts') -i -a | grep -c ESTABLISHED`, and the whole bug
class is the gap between the two. Expect `sockets` = `PNYX_UPSTREAM_CONNS` + 1 per connected client,
and lsof one higher than the gauge (it counts the inbound client socket too). Measured 2026-10-08
against the real walk: gauge 9, lsof 10, **flat across three forced indexer restarts** where the old
code would have climbed one per restart. `bin/leakwatch.sh` on the box samples both beside the walk
rate.

There is a second, stronger reason, found on the real walk: **the proxy turns an upstream WebSocket
blip into an indexer exit.** On 2026-10-02 at 03:00:03 UTC the upstream dropped, the proxy logged
`upstream closed, dropping in-flight requests` across every pool, and 30 s later `chain-indexer`
died with `index_blocks_task failed: get next block from node: cannot get online client`. Pointed
at the upstream directly, the indexer's own subxt client reconnects instead.

Two alternatives, for the record: a **local node** (RTT collapses, sync becomes CPU-bound) is
blocked by Cardano db-sync; **bootstrapping in eu-west-1** and copying the Postgres volume home
works and is verified portable, but costs a VM and a day where the proxy costs neither.

Tip-following after the initial walk is one block per 6 s and is unaffected by RTT.

## Running it

```sh
export PNYX_NET=mainnet
export PNYX_NODE_WS=wss://rpc.mainnet.midnight.network
export PNYX_PG=$(openssl rand -hex 16)
export PNYX_NATS=$(openssl rand -hex 16)
export PNYX_SECRET=$(openssl rand -hex 32)   # per host, store 0600, never in this repo
podman-compose -f infra/midnight-public/compose.yml up -d
```

Serve a second network by repeating with `PNYX_NET=preprod`, `PNYX_NODE_WS=wss://rpc.preprod…` and
`PNYX_API_PORT=8089`; every container, volume and port is named from `PNYX_NET`.

**Why not `indexer-standalone`.** It was the first thing deployed here and it crash-looped every
~50 s: `index_blocks_task failed: determine system parameters change: get latest D-parameter: pool
timed out while waiting for an open connection`. Standalone cannot opt out of its SPO task, which
starved SQLite's single connection; throttling `APP__SPO__INTERVAL` did not help. The cloud
topology does not deploy spo-indexer at all, and has not reproduced it once. It is not
restart-free, though: see "Reaching the tip" for the three the mainnet walk actually took.

Verify (the API is loopback-only by design; the tunnel is what publishes it):

```sh
curl -s -X POST http://127.0.0.1:8088/api/v4/graphql -H 'content-type: application/json' \
  -d '{"query":"{ block { height hash protocolVersion } }"}'
```

## Reaching the tip

**Left running it converges on its own — as long as every block applies.** Catch-up at 1.68M was
~28k blocks/h against mainnet's ~600 blocks/h (one block per 6 s), a **47:1** margin, so the rate
is never what stops the walk. ⚠️ **A block the ledger refuses is**, and one did: see "The walk
stopped at 1,788,980" below. Rate convergence is not progress convergence, and the two look
identical from outside.

⚠️ **The catch-up target is frozen at process start, not live.** `catching up by height` reported
`first_finalized_height: 2831683` unchanged across seven hours while the tip moved 2,838,000 →
2,843,439; 2,831,683 was the finalized head at the 03:00 UTC restart. So catch-up is two-phase:
walk to the startup target, then a second pass over the ~12k blocks produced meanwhile (well under
an hour), then `caught_up` turns true and `/ready` answers 200. Each restart moves the target
forward, which is why a long walk's target is the last restart's head and not the original one.

`/ready` answering **503 is the healthy state during the walk** — it means "not caught up", not a
fault. (`/alive` is a 404; the liveness path is spelled something else.)

⚠️⚠️ **At the tip, `/ready` 200 says NOTHING about progress, and that is the opposite of the tell
above.** `caught_up` latches true and never un-latches on a stall. Measured 2026-10-15: the mainnet
chain-indexer sat at height **3,018,825 for 17 hours** — last `block indexed` line 03:00:02 UTC,
then **2,063 x `subscription appears stuck, re-subscribing`** from `subxt_node.rs:418` with
`last_yielded_height: Some(3018825)`, all 400 of the last 400 log lines WARN and zero ERROR — while
`/ready` answered **200** and all five containers read `Up`. `restart: unless-stopped` cannot help:
the process never exits, it spins. The stall was inside the indexer, not the proxy: post-03:00 the
proxy received **zero `chainHead_v1_*` requests of any kind** (the re-subscribe never reached the
wire — just one `archive_v1_header` and one `archive_v1_call` per 30 s), no `window reseek`, and a
fresh follow probe through the proxy matched one straight to the upstream event for event.

▶▶ **So the only honest progress check is `select max(height) from blocks` compared against
itself.** Not `/ready`, not `podman ps`, not the proxy's `cursor` (frozen at the tip by design).
Recovery is a `pnyx-chain-indexer-mainnet` restart; it resumes from the last indexed height.

✅ **That check is now a job: `height-watchdog.ts`, every 5 minutes** via
`sudo bin/install-watchdog.sh` (a LaunchDaemon with `UserName`, matching
`ai.pnyx.midnight`, so it survives a reboot with nobody logged in). It **restarts** rather than only
logging, because the three outages it exists for were all the wedge class: the process does not
exit, so `restart: unless-stopped` can never fire, and a watchdog that only wrote a log line would
be the same failure mode a fourth time.

The rules, all covered by `height-watchdog.test.ts`:

| situation | what it does |
|---|---|
| height moved (either direction) | clears the stall count **and the restart budget** |
| height flat for 1 check (~5 min) | holds; mainnet makes ~50 blocks in five minutes, but one sample is not a stall |
| height flat for 2 checks (~10 min) | restarts `pnyx-chain-indexer-mainnet` |
| restarted under 30 min ago | holds, so it cannot churn |
| 3 restarts without movement | **escalates** and stops restarting: a human is needed |
| height unreadable (`podman exec` failed) | reports it and **leaves the state untouched** -- a flaky read is not a stall, and must never cause a restart |
| container not running | leaves it alone; somebody stopped it deliberately, and a crash-loop is already the restart policy's job |

⚠️ **Escalation has nowhere to shout.** Nothing on this box has an alerting channel, so `escalate`
writes a level-`error` line to `log/watchdog.log` and one `logger` line to the unified system log,
and that is all. Wiring it to something that reaches a person is open work; adding a third-party
service to do it needs a dev-lead call under the third-party policy.

**The proxy self-parks at the tip; it does not have to be removed for live mode to work.** The
stateful `chainHead_v1_*` path is in its `PASSTHROUGH` set and is relayed untouched, and when
`archive_v1_hashByHeight` returns nothing it sets `chainTipReached`, stops prefetching and walks
`prefetchTop` back to the cursor. Take it out anyway, for the two reasons above. One detail if it
is left in: eviction fires on cache size (`blocks.size > MAX_WARM`, `DEPTH * 8` = 768 heights), so a
bounded ~500-block cache stays resident; RSS was 5.3 GB after 1 d 11 h.

That bound replaced a height-triggered one on 2026-10-11, and the reason is worth keeping. Eviction
used to run inside `if (height > cursor)` every 512 heights, so it depended on the window only ever
moving up. At 03:00 UTC the indexer asked for the finalized head (2,961,230) before resuming at
2,439,xxx — a seek, not a walk — and that one request latched `cursor` near the tip for good: every
later `height > cursor` test failed, so eviction never ran again and `pump`'s `prefetchTop < cursor +
DEPTH` bound was always true. The cache grew from 350 to 7,826 heights in 25 minutes and the proxy
died of memory (no crash report, no error line, the box at 8.2 GB of 9.2 GB swap), which left the
chain-indexer crash-looping on a refused port for 9 hours. The window now follows the indexer in
both directions — a request more than `DEPTH` from `cursor` is treated as a reseek, logged as
`window reseek`, and clears the cache — and the size bound holds whatever the window does.

**What actually needs doing at or near the tip**, none of which catching up provides:

1. Point `APP__INFRA__NODE__URL` back at the upstream and stop the proxy.
2. Watch `indexer-api` wedging. Our pin is the ledger-v8 line without upstream fix 1440, so concurrent dust
   and merkle-tree reads can wedge it — which only bites once it is live and serving wallets. The
   edge rate limit below is the mitigation; watch `/ready`.
3. The power-cut hole is unchanged and no amount of syncing fixes it: `autorestart` is unsupported
   on Apple Silicon, so a power cut leaves the stack off until someone presses the button.

### The walk stopped at 1,788,980

⚠️ **The mainnet walk has not advanced since 2026-10-03 04:14 UTC.** It indexed to **1,788,979**
and every attempt at the next block exits the process:

```
cannot apply regular transaction e769b827…a6e35c0a: malformed transaction:
  transaction application error detected during verification:
  Intent TTL has expired. TTL: Timestamp(1784643562), Current block: Timestamp(1784643564)
```

Two seconds over TTL, on a block mainnet's own node accepted in July 2026. It is **deterministic**,
so `restart: unless-stopped` — which has no backoff — relaunched it into the same wall ~1,000 times
an hour: 9,239 process exits and 24,057 `starting` lines in a single 24 h window, for zero blocks.
This is the restart class the table below does *not* cover: nothing self-heals it.

**What it is not.** The read-ahead proxy is ruled out by measurement, not by argument: with
`APP__INFRA__NODE__URL` pointed straight at `wss://rpc.mainnet.midnight.network`, the same
transaction fails with the same two-second delta. Nor is it the box (99% idle, 107 GB Postgres on a
600 GB disk) or the `roots counts can't be negative` panic.

**What it is: a known, chain-wide defect at that block, and NOT our pin.** Upstream reports the
identical failure with the identical timestamps, in the **node** as well as the indexer:
[midnight-node issue 2229](https://github.com/midnightntwrk/midnight-node/issues/2229) — a fresh
mainnet sync from genesis halts at #1788979 with `TTL: Timestamp(1784643562), Current block:
Timestamp(1784643564)` and `Transaction(3) failed due to Invalid(Custom(182))`. Nodes already past
the block are unaffected; only replays from genesis hit it, which is exactly what we are doing.

The cause ([indexer issue 1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461)):
the node validates mempool transactions against a `tblock` bumped ahead of block time and caches the
verdict keyed on `(tx_hash, ledger_state_key)`; at inclusion a cache hit skips re-validation at the
real block time. So **the chain permanently contains transactions that fail a strict replay**, and
fixing the node's cache cannot help a replayer — those blocks are final.

⚠️⚠️ **Do not downgrade. There is no release to downgrade *to*.** The indexer fix is
[PR 1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610), merged to `main` on
**2026-09-29**, and every published release predates it: 4.4.0-rc.5 (09-18), our 4.3.800-rc.1
(08-28), 4.3.7 (08-18), 4.3.3 (06-04, still tagged latest). Swapping to what the support matrix puts
mainnet on moves *backwards* past the fix. The 107 GB database is intact and re-usable the moment a
fixed build exists.

**The fixes were written for this exact block, and for our ledger line.**
[node PR 2216](https://github.com/midnightntwrk/midnight-node/pull/2216) (`fix(ledger): retry
tblock-corrected first tx at the block's own tblock`, merged 2026-09-29) quotes our failure verbatim
— #1788979, `Transaction(3)`, both timestamps — and states that **only `ledger_8` needs it**, which
is the line we pin; `ledger_9` never skews the tblock. `Transaction(3)` is consistent with being the
block's *first regular* transaction, since the node's numbering counts inherents first, so the
first-tx shape of both fixes does cover us. Upstream also bumped the indexer to `node-2.1.0-rc.4`
([PR 1618](https://github.com/midnightntwrk/midnight-indexer/pull/1618), 2026-10-01), which carries
the 2.1.0 counterpart of that ledger fix.

⚠️ **What is still unverified is whether a fixed build accepts our existing database.** The 107 GB
volume stops at 1,788,979 under the 4.3.x / ledger-v8 line, and `main` has since moved to node 2.1.0;
if it resumes, we lose nothing, and if it refuses, the walk restarts. Test against a **copy**. Upstream QA issues
[1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630) /
[1631](https://github.com/midnightntwrk/midnight-indexer/issues/1631) /
[1632](https://github.com/midnightntwrk/midnight-indexer/issues/1632) (2026-10-02) ask for canaries
against "known-bad heights" and name 1788980, so upstream treats the class as open. Build `main` and
run it at 1,788,979 against a copy of the volume before trusting any release note. On the node side
the fix is in `node-2.1.0-rc.4`; the 1.0.x line is promised v1.0.400.

⚠️ **Nothing external shows this.** `/ready` answers 503 either way, four of five containers read
`Up 3 days`, and the host load is 1.2. The only tells are `chain-indexer` reporting `Up 4 seconds`
and a frozen `max(height)` in Postgres. Check progress by querying the height twice, never by
asking whether the stack is up.

**Restarts on the mainnet walk, for calibration.** Three self-healed by
`restart: unless-stopped`, resuming from the last indexed height with nothing lost. The fourth did
not, and no number of restarts will:

| when (UTC) | cause | self-healed |
|---|---|---|
| 2026-10-01 15:27 | crash loop — ~32 restarts in **nine seconds**, no backoff | yes |
| 2026-10-01 17:08 | the `roots counts can't be negative` ledger panic (`storage-core/src/backend.rs:761`) | yes |
| 2026-10-02 03:00 | upstream WebSocket dropped; `cannot get online client` | yes |
| 2026-10-03 04:14 | the TTL rejection above, block 1,788,980 | **no — deterministic** |

⚠️ **Do not read `podman inspect`'s `RestartCount` as an incident count** — it said **390**, almost
all of it the nine-second crash loop. Count `"message":"starting"` lines in the container log
instead. And check *which* restart you have before reaching for the version swap: of the four above
only one was the panic, and only one needs it.

## The scripts, and what the box still holds alone

`bin/` is the operational half, tracked here because it was not tracked anywhere until 2026-10-08:
it lived only in `~/pnyx-midnight/bin` on the host, one disk, no history, written the day it was
needed.

| script | what it does |
|---|---|
| `start.sh` | boot: the podman VM, the containers, the tunnel, and the proxy **only if** chain-indexer's own env points at it |
| `repoint-node.sh` | move chain-indexer between the upstream and the proxy, reusing its `CreateCommand`; verifies the height advances |
| `install-watchdog.sh` | install `height-watchdog.ts` as a 5-minute boot LaunchDaemon (needs sudo) |
| `provision-sudo.sh` | repurpose a Mac as the host; the root half, idempotent |
| `build-rc2.sh` | build indexer images from a release branch upstream has not published |
| `recreate-rc2.sh` | move the three containers to another tag, reusing each one's `CreateCommand` |
| `leakwatch.sh` | sample the walk rate beside the proxy's socket gauge and `lsof` |

⚠️ **The host is not a checkout.** `~/pnyx-midnight` is a plain directory, so every file here
exists twice with nothing linking the copies: edit one and the other silently becomes a lie. Copy
deliberately (`scp infra/midnight-public/readahead-proxy.ts <box>:~/pnyx-midnight/`) and check
`md5` on both sides afterwards.

⚠️ **The containers were never created from `compose.yml`.** They were hand-typed `podman run`
invocations, which is why `recreate-rc2.sh` has to recover their spec from
`podman inspect --format '{{.Config.CreateCommand}}'` rather than from a file in this directory.
Treat that inspect output as the authority on what is deployed, and `compose.yml` as the intent.

⚠️ **`start.sh` starts containers matching `--filter name=idx-`, and ours are named `pnyx-*`.** That
loop currently matches nothing; the four live containers come back after a reboot through podman's
own `--restart unless-stopped`, not through this script. Left as found rather than fixed blind,
because changing what boots is not a change to make without watching a reboot.

Secrets stay on the host: `~/pnyx-midnight/secrets/` (0600), read at runtime, never in this repo.

## Publishing it

Same shape as the sponsor host (`infra/sponsor-host/README.md`) and the asset-media origin:
`cloudflared` dials **out**, nothing listens on the public internet, the ingress rule is
dashboard-managed. WebSocket subscriptions pass through a tunnel, but set a keepalive — an idle WS
through Cloudflare is not guaranteed to live forever.

**As built (2026-10-01):** a tunnel named `pnyx-midnight`,
alongside the existing `pnyx-media` and `pnyx-sponsor`. Its ingress routes
`midnight-mainnet.pxkq.uk` → `http://127.0.0.1:8088`, everything else `http_status:404`. The
connector token lives at `~/pnyx-midnight/secrets/tunnel-token` (0600) on the host and is started
from `start.sh`, so the tunnel comes back with the stack at boot — `cloudflared service install`
wants root, and the boot daemon already runs as the owning user.

⚠️ **The DNS record is the one piece not automated.** The account's wrangler OAuth token carries
zone *list* but no DNS scope at all, and no origin `cert.pem` exists on any host (every tunnel here
was created dashboard-managed), so neither the API nor `cloudflared tunnel route dns` can write it.
It needs one CNAME, from the dashboard or a token with Zone:DNS:Edit:

```
midnight-mainnet  CNAME  <tunnel-id>.cfargotunnel.com  (proxied)
```

Until that record exists the tunnel is healthy and reaches nothing. Which is no loss yet: publishing
an indexer that is still walking the chain would serve partial history to anything that asked.

Put a rate limit at the edge before pointing the app at it. The origin is an unauthenticated
GraphQL API on the wedge-prone v8 line, and `max_complexity: 200` / `max_depth: 15` are the only
limits it applies by default.

## What self-hosting buys beyond cost

The quotas that currently shape our sync code are config lines here, not somebody's policy:
`max_session_subscriptions_per_minute: 10`, `max_concurrent_per_connection: 20`, `max_complexity`,
`max_depth`. Raise them to fit the wallet rather than working around them.

## The host, as built

A repurposed MacBook Pro (M5, 32 GB, ~800 GB free) running podman with a 6-CPU / 16 GB / 600 GB
applehv VM. The containers are the compose above; `~/pnyx-midnight/` holds the secrets (0600), the
start script and the read-ahead proxy.

- `ai.pnyx.midnight` is a **LaunchDaemon**, not a login agent, so the stack comes back at boot
  without auto-login. The provisioning script tests that before committing to it and falls back to a
  login agent if Virtualization.framework refuses a session-less start.
- `SleepDisabled 1` keeps it awake with the lid closed, no external display needed, verified by
  closing the lid for ~4.5 minutes while polling: zero unreachable samples and the indexer kept
  advancing throughout. `sleep 0`, `disksleep 0`, `powernap 0`, `womp 1`, `tcpkeepalive 1`.
- ⚠️ **`autorestart` is unsupported on Apple Silicon**, so a power cut leaves the machine off until
  someone presses the button. The boot daemon handles everything after that; it cannot press it.

## Edge rate limiting

`apply-rate-limit.ts` puts a per-IP cap in front of the hostname: **applied 2026-10-01**, 100
requests per 10 s, blocking 10 s. Sized for one wallet's worst honest burst rather than its average,
because a DUST rebuild walks generation and commitment updates a query at a time. The 10 s window
and 10 s block are the only values this zone's plan allows (`period: 60` is rejected with "can only
use a period among [10]", and the mitigation timeout must equal it).

It exists because the origin is an unauthenticated GraphQL API on the ledger-v8 indexer line, which
does not carry fix #1440: `indexer-api` wedges under concurrent ledger-DB reads, through the dust
and merkle-tree resolvers that wallet sync drives anyway. Until that fix reaches the v8 line, anyone
who finds the hostname can stop our indexer from a laptop.

```sh
CF_API_TOKEN=… bun infra/midnight-public/apply-rate-limit.ts --dry-run   # prints the merged phase
CF_API_TOKEN=… bun infra/midnight-public/apply-rate-limit.ts
```

⚠️ The script **merges**: writing that phase replaces every rate-limit rule in the zone, so a blind
`PUT` would silently delete whatever protects `media.pxkq.uk` and `config.pxkq.uk`. It reads the
phase, drops only its own rule by description, appends the current one, and writes the result back.

Applied with a temporary, IP-restricted token (stored at `~/.config/pnyx/cloudflare-token`, expires
2026-10-08). The standing wrangler OAuth token has no zone scopes, so a durable token with
**Zone:WAF:Edit** is what re-running this needs after the temporary one lapses.
