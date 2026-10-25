# pnyx-landing

The public marketing page, at **<https://www.pxkq.uk/pnyx>**.

Static HTML and WebP screenshots, served from Workers static assets. There is no build step, no
framework and no data: edit `public/pnyx.html` and deploy.

## ⚠️ There is no Worker script, and that is the point

`wrangler.jsonc` has **no `main`**. Workers static assets are free, unlimited and never invoke a
Worker, so every request this deployment answers — page, screenshots, release manifest, the apex
redirect — costs nothing and runs no code.

The one thing that cannot be an asset is a build: assets cap at **25 MiB** and the APK is ~225 MB.
Those sit in R2 `pnyx-releases` and are served by that bucket's **own custom domain**,
`downloads.pxkq.uk`, which is also Worker-free. So nothing on this site is billed per request.

It did briefly have a script, for `/pnyx/download/*`, before the bucket got its own hostname —
`_redirects` still forwards that path so links shared in that window resolve.

⚠️ **Adding `main` back turns a free page into a billed one.** Anything that would make the page
call a Worker on load — reading R2 at request time, server-rendering, an API route — belongs in an
asset instead, the way `releases.json` is.

```bash
cd services/landing
bunx wrangler dev        # http://localhost:8787/pnyx
bunx wrangler deploy
```

## What it is made of

| path | what | served by |
|---|---|---|
| `public/pnyx.html` | the whole page — markup, CSS and the one script inline, no external requests | assets (free) |
| `public/pnyx/shots/*.webp` | screenshots, 620 px wide, taken from a real build | assets (free) |
| `public/pnyx/releases.json` | the published-build manifest the page reads, written by `infra/releases/publish.ts` | assets (free) |
| `public/_redirects` | `/` → `/pnyx`, and the retired `/pnyx/download/*` → `downloads.pxkq.uk`. Parsed by the asset layer, never served | assets (free) |

Builds are not here at all: they are R2 objects under `builds/`, published by
[`../../infra/releases/`](../../infra/releases/) and served from `downloads.pxkq.uk`.

`/pnyx` is canonical and needs no redirect: the page is `public/pnyx.html`, so `html_handling`
answers `/pnyx` directly and sends `/pnyx/` back to it.

⚠️ **The custom domain claims the whole of `www.pxkq.uk`, not just `/pnyx`.** Anything else that
ever wants a path on www has to be served by this Worker. See `infra/cloudflare/README.md`.

## The screenshots

They are real, from a dev build driven on the Android emulator against the **Midnight preprod**
network and a Cardano preprod wallet — which is why the status badge reads `PREPROD` and the
Cardano tokens have no artwork (preprod test assets have no media anywhere, so that is correct
rather than a broken media rig).

To refresh one: capture at the device's native 1080×2424, then

```bash
magick <shot>.png -resize 620x -strip -quality 92 public/pnyx/shots/<name>.webp
```

Keep the `width`/`height` attributes in the HTML matching the new file, or the page will shift
while it loads.

## Claims discipline

Every capability the page names was checked against the code or the running app before it was
written. The page deliberately says what is **not** built yet — BTC/EVM/SOL are derive-only,
everything is on a test network, data will not survive the move to mainnet. If a claim here stops
being true, this page is part of the change (repo Documentation Sync rule).
