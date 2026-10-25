# infra

**Everything that runs outside this workstation and outside the app.** Cloudflare, the VPS, the Mac,
the Pi — if changing it means reaching another machine or another account, it is described here.

Code that *runs* on those boxes still lives with the thing it belongs to (the Workers in
`services/`, the sponsor server in `services/content/src/`). What this tree holds is the operational
half: how a box is provisioned, what is deployed onto it, how it is reached, and where its secrets
sit. **No secret is in this tree, and none ever should be** — every box reads its own at mode 0600.

## The boxes

| box | what runs there | here | runbook |
|---|---|---|---|
| **Cloudflare** | the content Worker, the cron data Worker, the landing Worker, four R2-direct hostnames, three tunnels, the control plane | [`cloudflare/`](cloudflare/) | `docs/remote-config.md`, `docs/cloudflare-migration-plan.md` |
| **Pre-release builds** | the `pnyx-releases` bucket and the script that publishes into it, behind `www.pxkq.uk/pnyx/download/*` | [`releases/`](releases/) | that directory's README |
| **The VPS** | the sponsor wallet: a router plus one process per Midnight network, behind `sponsor.pxkq.uk` | [`sponsor-host/`](sponsor-host/) | `docs/SPONSOR_HOST.md` |
| **The Mac** | the self-hosted Midnight indexer stack in podman, behind `midnight-mainnet.pxkq.uk` | [`midnight-public/`](midnight-public/) | that directory's README |
| **The Pi** | the media rig: the Cardano token-media crawl, kubo, and the nginx origin behind `media.pxkq.uk` | [`media-rig/`](media-rig/) | [`media-rig/RIG.md`](media-rig/RIG.md) |
| **This workstation** | the local Midnight chain, for `e2e:local` | [`standalone/`](standalone/) | `bun run chain:up` / `chain:down` |

✅ **The media rig is in-tree since 2026-10-15**, taken from the Pi's live `~/media-rig` (the
authoritative copy) plus the four systemd units and the nginx site read off `/etc`. Until then it was
under no version control anywhere: three plain directories with no `.git` in any of them. The two
workstation copies (`cardano-media-blob`, `cardano-media-blob-backup`) are now stale by definition
— ▶ delete them once this is trusted, so there is one source again.

✅ **The code fixes are deployed** (2026-10-15 11:59 CEST): the three scrubbed pipeline files and
both Rust sources went to the box, the binaries were rebuilt there so source and binary do not drift,
and `pnyx-mediafetch` was restarted so the new user-agent is loaded. Proven on the wire rather than
inferred — the production `fetch.ts`, pointed at a local listener through its own `GATEWAYS`
override and a throwaway one-row database, sends
`pnyx-media-blob/0.1 (+cardano native-asset media archival; https://media.pxkq.uk)`. The live
corpus was not touched to test it.

The units in [`media-rig/deploy/`](media-rig/deploy/) are **templates**, carrying `<user>` where the
box has a real account; the installed copies are unchanged and correct. Do not rsync those.

▶ **Still no push script.** This deploy was by hand, file by file, and so was the 2026-10-18 crawl
fix. The next one should be `infra/media-rig/scripts/push.sh`, the shape of
[`../sponsor-host/push.sh`](../sponsor-host/push.sh), with the unit templating in it.
[`../proxy/push.sh`](../proxy/push.sh) is a closer model for the build-on-the-box part.

⚠️ `pipeline/` is **excluded from the typecheck pass**: 36 errors in 8 files at import, because it
was written standalone under bun's defaults. The count is in `tsconfig.typecheck.json` beside the
exclusion. Four of them are `pipeline/vendor/` — a copy of `packages/crypto` that has gone stale
against @noble v2 — which is the argument for deleting `vendor/` rather than typing it.

⚠️ **`standalone/` is the one thing here that is not off-box.** It predates this tree, it is the
local chain, and moving it out would be churn for nothing — but do not read it as the pattern.

## What is covered, and by what

Bringing `infra/` into the repo's gates was part of making it a real tree rather than a drop box:

- `infra/**/*.ts` is type-checked by `tsconfig.typecheck.json` (⚠️ this surfaced a live type error in
  `midnight-public/readahead-proxy.ts` the day it was switched on — the file had never been checked).
- `infra/**/*.test.ts` runs under vitest and is type-checked by `tsconfig.tests.json`.
- ⚠️ **`infra/` is *not* in the silent-catch guard** (`SEARCH_ROOTS` in
  `app/src/logger/silent-catch.test.ts`), and neither is `services/`. That gap is a tracked
  item, not a decision — see the s162 entry in `docs/FOLLOW_UPS.md`.
- Shell scripts here are checked by nothing. Treat a change to one as untested until it has run
  against a box.

## Queued

⏸ **Deploying the token-holding proxy.** It is **built and verified** against the real upstreams
([`proxy/`](proxy/)) and the box is decided — **the VPS**, because Blockfrost's rate limit is keyed
by egress IP and that is the box with a stable one, 24/7, already holding credentials. What is left
is one `PROXY_SSH=... infra/proxy/push.sh`, a tunnel hostname, and then
`docs/remote-config.md` Case A3 to move the fleet onto it and retire the embedded SteelSwap key.
