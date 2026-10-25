# The media rig, on the Pi

Everything that used to run on the MacBook runs here now. The Mac is no longer part of
the rail: no crawl, no kubo, no rsync leg, no reverse tunnel dependency.

```
~/media-rig/
  pipeline/          fetch.ts, reconcile.ts, ingest-*.ts, vendor/ (CIP-14) + node_modules
  extract-probe/     Rust probe + cip68, built for aarch64 (target/release/)
  data/
    assets.db        the corpus — THE source of truth for what is banked
    topup.state      {"last_immutable": N, "last_slot": S} — where the corpus ends
    meta721.jsonl    full 721 extract to 2026-07-25 (rebuild insurance, not read at runtime)
    token-registry/  Cardano token-registry clone for ingest-registry.ts
  out/media -> /srv/pnyx-media/v1     the crawl writes STRAIGHT into the served tree
  scripts/           run-fetch.sh, topup.sh, status.sh, systemd/, mithril/
  logs/              fetch.log, topup.log
  ipfs/              kubo repo (lowpower profile)
```

## Services

| unit | what it does | cadence |
|---|---|---|
| `pnyx-mediafetch.service` | the crawl: public IPFS gateways, kubo last | always on |
| `pnyx-kubo.service` | local IPFS, tried last by the crawl (+4.3pp measured) | always on |
| `pnyx-topup.timer` → `.service` | new mints since the last run → assets.db | daily 04:20 |
| `nginx` / `cloudflared` | the origin behind `media.pxkq.uk` | always on |

`~/media-rig/scripts/status.sh` prints corpus, coverage by mint year, services, disk and
a live edge check in one screen.

## Three things that differ from the Mac

1. **The crawl writes into the live nginx root.** `out/media` is a symlink to
   `/srv/pnyx-media/v1`, so a banked thumbnail is servable the moment it is written —
   the 40-minute rsync lag is gone. `fetch.ts` writes `.<fp>.256.webp.tmp` and renames,
   because a half-written file served once would be cached `immutable` at the edge for
   a year.
2. **kubo's gateway is on :8081**, not :8080 — nginx owns :8080 here. `fetch.ts` reads
   `KUBO_GATEWAY`; with the old hardcoded :8080 every kubo read would have hit nginx,
   404'd, and scored as a public-gateway miss.
3. **New entries are scheduled.** Nothing ever scheduled the extract before, which is
   why the corpus sat 47 days stale. `topup.sh` downloads only the immutable range it
   is missing (Mithril v2 `--start/--end`, ~4 chunks ≈ 100 MB/day, not the 235 GB
   snapshot), re-downloads the last chunk it already has so an overlap *proves* there
   is no hole, extracts, ingests, and writes `data/topup.state`.

## Two defects fixed 2026-10-18, both of which hid behind a healthy-looking unit

**1. 🐞 The crawl was OOM-killed roughly hourly and `systemctl` said `active (running)`.** The unit
is `run-fetch.sh`; it was the *child* `bun` that died, six times on 2026-10-18 alone. Cause was
`fetch.ts` calling `.all()` on the unbounded retryable set — **2,896,360 rows, ~1.5 GB of JS
strings, on a 3.7 GB box** — so a pass never lived long enough to finish. Three bounds fixed it:

- rows now **stream in keyset batches** (`BATCH`, default 2000), cursor-based so a row is visited
  once per pass even though `not-found`/`timeout` stay retryable;
- `sharp.cache(false)` + `sharp.concurrency(1)`, because libvips otherwise keeps a decoded-image
  cache and a per-call thread pool sized to the core count, multiplied by every worker;
- `MAX_PIXELS` (default 50 MP) replaces a 500 MP input ceiling that let one 50 MB source ask for
  2 GB in a single decode.

Measured on the box, before → after: system memory used **2,638 MB → 584 MB**, throughput
**2.7/s → 4.7-16.9/s**. The rate rose because the box had been thrashing, not because the crawl
got faster.

Crawler RSS went from **1.7-3.0 GB and climbing to a kill** to a **sawtooth that returns**: ~300 MB
at rest, peaking ~680 MB through image-heavy stretches and falling back within minutes, 60-76 MB on
not-found-heavy ones. Sampled over 20 minutes to confirm it comes back down rather than claiming a
single low reading — the peak is the number that matters on a 3.7 GB box shared with four services.

**2. 🐞 `pnyx-topup` had ingested nothing for days and failed every night, correctly.** The guard
was right and nothing acted on it: `last_immutable` was recorded from `$LATEST` — *what we asked
the aggregator for* — rather than from the chunks the download actually delivered, so the state
drifted ahead of the corpus and every later pass started past its own data. Three changes:
`OVERLAP` (default 3 chunks, was effectively 1), `last_immutable` read from the **highest chunk on
disk**, and a bounded widen-and-retry instead of a nightly fatal. First run closed it on attempt 1:
`slots 197618407..200685589`, `+6259 new assets`.

⚠️ `journalctl -u` shows only systemd's lines for both units. The logs are
`~/media-rig/logs/{fetch,topup}.log` — "active (running)" and a nightly `status=1/FAILURE` each
told you nothing about why.

⚠️ **Pre-existing and not fixed:** `run-fetch.sh` runs three `COUNT`/`SUM` scans of an 8.7 GB
database before every cycle, with no index on `status`. That is 5-10 minutes of disk before the
crawl starts, every cycle, competing with the crawl for I/O. A covering index on
`(status, out_bytes)` would fix it; it needs the write lock, so build it while the crawl is stopped.

## Knobs

```bash
# concurrency: IPFS_CONC (default 24) — the Pi is a web origin first
# a top-up now, outside the timer:
systemctl start pnyx-topup.service && journalctl -fu pnyx-topup
```

`topup.sh` stops the crawl while it ingests (SQLite has one writer) and restarts it on
every exit path, including failure. The crawl is resumable by design — stopping it is
always safe.
