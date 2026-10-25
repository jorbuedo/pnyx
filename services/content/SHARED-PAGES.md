# Shared pages — semi-private HTML on pnyx.pxkq.uk

Static HTML documents served from `public/<uuid>/` as **Workers Static Assets**
(free, no Worker invocation — same mechanism as `/.well-known`, see
[`WELLKNOWN.md`](./WELLKNOWN.md)). Used for sharing a document by link with people
outside the repo: a reviewer, a partner, someone who needs the picture without a
git checkout.

> **This file deliberately lives OUTSIDE `public/`.** Everything under `public/` is
> uploaded and world-readable. Never put notes, drafts, credentials, or internal
> READMEs in there.

## Live pages

| Path | URL | Source of truth |
|---|---|---|
| `public/814a6359-cd63-4485-825f-b2bd40772df2/index.html` | https://pnyx.pxkq.uk/814a6359-cd63-4485-825f-b2bd40772df2/ | `../../../midnight-research/apps/community-contract-intents.md` |

*(Community on Midnight — problem, solution, and contract intents. WIP draft,
first published 2026-07-28.)*

## Editing an existing page

1. Edit the HTML in `public/<uuid>/index.html`.
2. If it mirrors a markdown source, edit that too — keep the pair in sync, and note
   which one is authoritative in the table above.
3. Redeploy:
   ```sh
   cd services/content && bunx wrangler deploy
   ```
4. Verify (the edge takes a few seconds to propagate — a 404 immediately after a
   deploy is usually propagation, not a fault):
   ```sh
   curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
     https://pnyx.pxkq.uk/<uuid>/
   ```

The URL never changes, so an already-shared link keeps working across edits.

## Adding a new page

```sh
uuidgen | tr 'A-Z' 'a-z'                    # e.g. 814a6359-cd63-4485-825f-b2bd40772df2
mkdir -p public/$UUID
$EDITOR public/$UUID/index.html
cd services/content && bunx wrangler deploy
```

Then add a row to the table above.

Requirements for the HTML itself:

- **Self-contained.** No CDN scripts, external stylesheets, remote fonts or images —
  inline the CSS and embed assets as `data:` URIs. Nothing should depend on a third
  party staying up (or seeing the reader's IP).
- **`<meta name="robots" content="noindex, nofollow, noarchive">`** in the head.
- **Label the status honestly** in the page itself (e.g. a WIP-draft banner) if it is
  not a finished, agreed document. A link outlives the conversation that produced it.

## Rules and caveats

- **This is obscurity, not access control.** An unguessable path is not a password.
  Anyone who receives the URL can open it, and link-unfurlers (Slack, Gmail, corporate
  proxies) will fetch and may cache the page. Do not put anything here that would be
  damaging if it leaked — for that, use a real auth surface, not a UUID.
- **No `robots.txt` `Disallow` entry.** It would publish the very path being kept
  quiet. The `noindex` meta tag plus "nothing links here" is the whole strategy.
- **Never create `public/index.html`.** That would become the landing page for
  `pnyx.pxkq.uk` and shadow the Worker's root. Root must keep falling through to the
  API.
- **`wrangler deploy` redeploys the Worker too**, not just the assets — `src/worker.ts`
  ships from the current working tree. Before deploying a page edit, make sure the
  Worker source is in a state you want live.
- **Assets only ship if they are on disk.** An asset deploy from a clean checkout that
  lacks these files would remove them from the edge, so the HTML must stay committed.
- **Canonical URL is the trailing-slash form.** `html_handling` defaults to
  `auto-trailing-slash`, so `/<uuid>` and `/<uuid>/index.html` both `307` to
  `/<uuid>/`. Share the trailing-slash form.

## Removing a page

Delete the directory and redeploy; the asset is dropped from the edge and the URL
starts returning the Worker's `404`. Anyone holding the link keeps the copy their
browser or an unfurler already cached, so treat removal as "stop sharing", not
"unpublish".
