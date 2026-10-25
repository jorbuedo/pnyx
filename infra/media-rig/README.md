# cardano-media-blob

⚠️ **This file describes the original 720px design, and the rig does not ship it.** What runs is
**256px**, written straight into the nginx tree and served as `/{fingerprint}/256.webp` from
`/srv/pnyx-media/v1/{shard}/{fingerprint}.256.webp` (shard = `fingerprint[6:8]`) — `fetch.ts`
defaults `SIZE=256` and `deploy/pnyx-media.conf` only matches `256.webp`. The measurements below
were taken at 720 and are kept as the record of why the decisions went the way they did; for the
deployed shape read [`RIG.md`](RIG.md) and `deploy/`. There is no `rclone` leg and no R2 bucket:
the Pi is the origin, behind a Cloudflare Tunnel.

Build a local Cardano native-asset **media blob** — one capped 720px WebP per asset,
keyed by CIP-14 fingerprint — ready to `rclone copy` to Cloudflare R2. All data comes
from the local mainnet ImmutableDB (`~/cardano-db/db/immutable`); **no external media backend
bucket reads**. Object key: `media/{fingerprint}/720.webp`.

## Pipeline

```
~/cardano-db/db/immutable/*.chunk  (mainnet ImmutableDB, read directly — no node socket)
   │
   ├─ extract-probe (Rust/pallas)
   │    probe  → data/meta721.jsonl   CIP-25 label-721 metadata per tx + mints (ground truth)
   │    cip68  → data/cip68.jsonl     CIP-68 image from label-100 ref-NFT INLINE DATUMS
   │
   ├─ pipeline (bun)
   │    reconcile.ts       meta721.jsonl → assets.db  (721 shape traps, name↔mint match, latest slot)
   │    ingest-cip68.ts    cip68.jsonl   → assets.db
   │    ingest-registry.ts token registry base64 logos → assets.db  (kind=ft-logo)
   │    fixup-resolve.ts   re-resolve any 'other'/'none' rows with the current resolver
   │    fetch.ts           assets.db → out/media/{fp}/720.webp  (RESUMABLE, gateway rotation + kubo)
   │    manifest.ts        assets.db → manifest.jsonl  (one row per asset)
   │    checkpoint-report.ts → coverage-checkpoint.md
   │
   └─ out/media/{fingerprint}/720.webp   +   manifest.jsonl   +   coverage-checkpoint.md
```

`assets.db` (SQLite) is the single source of truth AND the resumable fetch state.

## Fingerprint contract

`media/{fingerprint}/720.webp` — the wallet computes this key locally, so it MUST
byte-match `app/src/services/cardano-assets/asset-fingerprint.ts`. We **vendor that exact source**
(`pipeline/vendor/`) rather than reimplement. Verified: `bun run verify-fingerprint.ts`
→ 8/8 CIP-14 published vectors.

## Run order (full)

```bash
# 1. extract (Rust) — ~9 min + ~6 min, reads the whole dump
cd extract-probe && cargo build --release
./target/release/probe ~/cardano-db/db/immutable ../data/meta721.jsonl
./target/release/cip68 ~/cardano-db/db/immutable ../data/cip68.jsonl

# 2. reconcile + ingest (bun)
cd ../pipeline
bun run verify-fingerprint.ts                 # gate: 8/8 CIP-14
bun run reconcile.ts      ../data/meta721.jsonl ../data/assets.db
bun run ingest-cip68.ts   ../data/cip68.jsonl   ../data/assets.db
bun run ingest-registry.ts ../data/token-registry ../data/assets.db

# 3. fetch (days, resumable — safe to Ctrl-C and re-run; never re-fetches 'ok')
ipfs daemon &                                  # local kubo = marginal coverage lever
CONC=48 bun run fetch.ts ../data/assets.db ../out

# 4. outputs
bun run manifest.ts ../data/assets.db ../manifest.jsonl
bun run checkpoint-report.ts ../data/assets.db ../data/extract.summary.log ../coverage-checkpoint.md
```

Validation-only knobs on `fetch.ts`: `LIMIT=N`, `SCHEMES=ipfs,http,...`, `SAMPLE=1` (random order).

## Decisions (locked)

- **Fingerprint**: vendored wallet code, not a reimplementation.
- **CIP-68**: extracted from inline datums in the chunks (label 100 ref NFT) — no
  kupo/ogmios. Contrary to the usual assumption, immutable chunks are sufficient.
- **Animation**: animated sources → animated WebP (chosen). Note: ~6× the storage of
  first-frame stills (2 MB vs 23 KB avg) → full blob ~1.5 TB vs ~232 GB.
- **Coverage**: a missed image is a manifest row with a `status` reason, never a
  placeholder. The failure list is the record of what is permanently lost once the

## Measured (calibration + build-only validation)

- Fetch hit-rate (single-pass, lower bound): IPFS ~71-82%, Arweave 95%, HTTP ~20%
  (dead domains), data/registry 100%.
- Local **kubo marginal: +4.3pp** — served 52/1200 CIDs no public gateway could.
- Public gateways are individually flaky under load (ipfs.io rate-limited & auto-dropped
  mid-run; nftstorage.link carried the batch) → rotation is essential.
- Output WebP: still policy mean 32.5 KB; animated mean 2 MB.
