# @pnyx/content-service

Content-plane backend for the forum: verify that a caller controls an on-chain **identity row**,
issue an ES256 session JWT, and serve the content plane behind it.

SIWM (a connector-signed CAIP-122 message bound to an `mn_addr`) was the original login rail and is
**retired** — an `mn_addr` is an identity the contract cannot check, which is the whole reason the
identity row exists (`docs/PNYX_IDENTITY_PLAN.md`).

**MIGRATED to Cloudflare (2026-07-18): the content plane runs as a Worker on D1**
(`src/worker.ts`, live on pnyx.pxkq.uk — see `docs/cloudflare-migration-plan.md`).
The content store behind `store.ts`'s interface is the
seam: `src/d1-store.ts` (Cloudflare D1) is the production backend, exercised alongside
the JSON store by `store.contract.test.ts`. Identity-row auth (ES256 JWT + JWKS), nonces
(D1-backed on the Worker), and content CRUD all run in the Worker; the chain worker
(long-lived stateful wallet sync + FIFO proof/tx queue) **stays here** as the Node
process and is tunneled (`/chain/*`).

The Node entry (`src/server.ts`) uses the JSON store (`.data/content.json`) for local
chain-mirror dev. The store interface is Promise-based; `src/store.contract.test.ts` runs
the same contract against every backend in its `backends` list — today the D1 store, via
an in-process Miniflare D1 seeded from `migrations/`. No external service or env var is
needed to run it.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/nonce` | Single-use nonce for anything the identity key signs (login, device binding) |
| POST | `/auth/identity` | `{identity, nonce, signature}` → `{token, identity}` or 401. Ed25519 over `authChallengeMessage`, checked against `authPub` in the identity's on-chain row. (Replaced `/auth/siwm`, which is gone with SIWM itself.) |
| POST | `/register` | Relay a **proven** `publishIdentityRow` transaction → 202. Unauthenticated by necessity — it is what bootstraps authentication — and safe because the service cannot author what it relays. **Rate-limited per IP (5/min)**, because every call makes the sponsor wallet spend DUST. |
| GET | `/.well-known/jwks.json` | JWT verification key for the content plane |
| POST | `/devices` | JWT-authed **and identity-signed** `{fcmToken, platform, nonce, signature}` → register the caller's device for push |
| GET | `/health` | Liveness |
| GET | `/status` | Aggregate health: the sponsor host's own verdict, the D1 binding, and whether the chain plane can write. HTML in a browser, JSON otherwise. **Unauthenticated, so every probe decides what is safe to publish** — states and reasons only, never an upstream body (that is how the sponsor's balances leaked on the first deploy) |

`/chain/*` (`state`, `submit`, `artifacts`, `params/:k`) exist only where a sponsor wallet does — the
Worker answers 503. Artifacts are served from R2 in shipping builds and contract state comes from an
indexer, so the app's dependency on that plane is writes only.

## Push notifications (phase 4 item 12 — code side)

Forum events produce `NotificationIntent`s (`src/notifications.ts`:
`{subjectAddress, communityId, kind, payload}`) which fan out to the recipient's
registered devices through the `PushSender` seam (`src/push.ts`):

- **post-reply** → the parent post's author (persona → subject resolved server-side);
- **new-proposal** → every circle member except the author;
- **poll-result** → the proposal author on every tally movement (no poll-close lifecycle
  exists yet; a later pass narrows this to poll close).

An interim Firebase project exists and test notifications were verified on device.

Both runtimes send for real when `FIREBASE_SERVICE_ACCOUNT` is set, and log instead when it is not:

- **Worker (the origin)** — `src/push-worker.ts` does FCM HTTP v1 directly: a `jose`-signed RS256
  service-account assertion exchanged for an access token (cached per isolate, refreshed a minute
  early), then `messages:send`. No firebase-admin, which is a Node library. **Set and live on
  `pnyx.pxkq.uk`** (project `pnyx-app`); re-set with
  `bunx wrangler secret put FIREBASE_SERVICE_ACCOUNT < .secrets/firebase-service-account.json`.
- **Node (`src/push.ts`)** — the firebase-admin sender; local dev only now:
  `FIREBASE_SERVICE_ACCOUNT=$PWD/.secrets/firebase-service-account.json bun run dev`.

The credential lives at `services/content/.secrets/firebase-service-account.json` — **gitignored, and
the directory is ignored wholesale**. It is not in the repo; download it from the Firebase console for
project **`pnyx-app`**, which is what `app/google-services.json` names.

⚠️ **Check the `project_id` before using it.** A key from a different project authenticates fine and
then has every send refused, because the device token was minted by another project — and probing FCM
with it returns a 404 that proves nothing. A stale `midnight-agora` key sat here until 2026-09-01 and
cost a wrong turn during a push outage that had a different cause entirely.

A malformed secret throws at startup rather than silently degrading to a dry-run. A token FCM reports
as `UNREGISTERED` raises `UnregisteredDeviceError` — part of the `PushSender` contract, not of one
implementation — and the fan-out forgets it (`ContentStore.removeDevice`, idempotent, covered for both
backends by the store contract test). Any other failure is treated as transient: logged, token kept.

Push only wakes the app — live circle/DM updates are the Durable Object socket's job, not a
notification payload's (`realtime-plane-durable-objects` memory). Device tokens store through the `ContentStore` interface
(both backends). App side: `app/src/platform/notification-tools.ts` stores the
FCM token locally; the pnyx session flow (`app/src/providers/use-device-registration.ts`)
POSTs it to `/devices` with the session JWT on sign-in and on token rotation.

**Binding a token requires proving ownership of the identity, not just holding its JWT.**
A JWT is a bearer credential: on its own it would let whoever holds one bind their own
device and receive that identity's notifications — who messages it, which circles are
busy. So the body also carries a single-use `nonce` (`GET /auth/nonce`) and an Ed25519
`signature` over `deviceBindingMessage(domain, network, pnyxId, nonce, fcmToken, platform)`,
verified against `authPub` in the identity's on-chain row — the same key and nonce store
login uses, under the distinct `pnyx:fcm:v1` tag so neither signature can be replayed as
the other. `/auth/dev` sessions are exempt (subject `dev:<name>` has no identity key at
all) and only while `DEV_AUTH=1`, which must never be a public origin.

## Login verification chain

1. `GET /auth/nonce` — single-use, short TTL.
2. The client signs `authChallengeMessage(domain, network, pnyxId, nonce)` (Ed25519) with the key
   derived from `identitySk`, and POSTs `{identity, nonce, signature}` to `/auth/identity`.
3. The nonce is consumed **before** the chain read, so a replayed challenge cannot be used to probe
   which identities exist.
4. The `pnyx_id` must decode, carry this deployment's network in its HRP, and be in **canonical**
   form — two accepted spellings of one id would be two JWT subjects for one keypair, and the subject
   is what enforces vote-once and one-membership-per-circle under BINARY collation.
5. The signature is verified against `authPub` read from the identity's row on chain. The trust is not
   in the scheme (Ed25519, checked only by us) but in *where the public half lives*: writing that row
   required a proof of knowledge in-circuit, so a signature that checks out against it establishes
   what SIWM's BIP-340 did, without the connector machinery.
6. Issue ES256 JWT: `sub` = the canonical `pnyx_id`, `iss` = `https://pnyx-content-service`,
   `aud` = `pnyx`, 1h TTL, `network` claim.

Registration precedes the first login rather than following it (login reads `authPub` from the row),
which is why `/register` is unauthenticated — see the endpoint table.

⚠️ **Step 5 is the Worker's own indexer read.** The row lookup (`src/midnight-indexer.ts`) needs
`MIDNIGHT_INDEXER_URL` to serve `MIDNIGHT_NETWORK`'s chain. Preprod's indexer is Blockfrost and needs
a key, sent as a `project_id` **header** — so the URL stays a plain var in `wrangler.jsonc` and only
the key is a secret:

```bash
bunx wrangler secret put MIDNIGHT_INDEXER_PROJECT_ID
```

Unset → identity row reads report as not configured. **Pointed at a dead host → every login is refused
with `401 identity registry unavailable` while `/register` keeps working**, because registration never
reads a row. That is exactly what happened on 2026-10-13 when Midnight's public indexers began
answering 410 and only the app and the sponsor were repointed (`docs/CHAIN_ENDPOINTS.md`).

## Chain mirror hardening (2026-07-05 incident)

A real-device session hit `RpcError: 1010: Invalid Transaction: Custom error: 117` when a
vote was submitted seconds after a join. Decoded against midnight-node sources: 117 =
`MalformedError::NotNormalized`, node log `"non-canonical dust actions: empty"` — the
wallet-sdk computes a **zero fee** on an idle dev chain (the dynamic dust price decays to
0 between transactions; each landed tx bumps it briefly, which made the failure look like
a coin race) and still attaches an empty `DustActions` intent, which the node rejects.
Fixes in `@pnyx/chain-client`:

- `balancing.ts` — drop a pure dust no-op balancing tx from the recipe (mirror of
  midnight-node PR #758's toolkit fix).
- `submission.ts` + `wallet.ts` — for genuine coin races (`DustDoubleSpend`, custom 196):
  after every submission the FIFO queue blocks until the wallet's `pendingDust` drains
  (its own spend observed on-chain), and 1010-class rejections retry with
  resync + rebuild + exponential backoff (bounded). Mirror tasks stay `pending` during
  retries.
- ⚠️ Restart recovery is **gone** with the server-proving rail: `replayChainBacklog` could only
  rebuild transactions this service proved itself, and it no longer proves any. A device-proven
  submission the sponsor accepted is replayed from the sponsor host's backlog file; one that failed
  before that is retried from the device, which is the only place its witnesses exist. The old note:
- ~~`replayChainBacklog` re-enqueues mirror tasks stuck in `failed` whose
  dependencies are satisfied (the store records vote values solely to make failed vote
  mirrors replayable — part of the documented dev-mode trust gap).

Known upstream issue (2026-07-05): on the long-lived standalone contract, the ledger-v8
WASM panics in `transaction_feesWithMargin` for `joinOpenCircle` transactions once the
global members tree has grown past ~a dozen leaves (`Unreachable code should not be
executed`; `createCircle` still lands, `feeBlocksMargin` value irrelevant). The submitter
treats the panic as retryable; tasks that still fail stay replayable on restart. A fresh
`bun run e2e:local` deploy clears it.

## Retention sweep (cron)

`triggers.crons` in `wrangler.jsonc` fires `scheduled` in `src/worker.ts` daily at 04:17 UTC. Windows
and reasoning: `src/dm-retention.ts`.

⚠️ **This is the Worker's only scheduled work, and the only reaper that does not need the device.**
Every other deletion in the DM tables is the recipient's or the owner's own act — a Welcome and a
message go on ack, an unclaimed key package goes when its owner retires it — so an install that never
comes back left its rows there for ever, and a *reinstalled* one cannot even name the packages it
published. That is how 406 of 411 key packages came to be unclaimed with nothing pruning them.

Five rules, counted separately in the log line (`origin: "dm-retention"`):

| rule | window | note |
|---|---|---|
| unacked welcomes | 30 days | the thread's re-establish flow replaces an invite that can no longer be opened |
| unacked messages | 30 days | |
| unclaimed key packages, per subject | newest 40 kept | 2× the client's `POOL_TARGET`; the **oldest** surplus goes, which is the orphaned batch |
| unclaimed key packages, by age | 90 days | a dormant subject sits under the cap for ever |
| claimed tombstones | bytes emptied after 7 days | ⚠️ the **row stays for ever** — it is what stops `INSERT OR IGNORE` resurrecting a spent single-use init key |

⚠️ **The pool rules are a liveness fix before a storage one.** A reinstalled device leaves its public
halves published with the private ones gone, so those rows are claimable and dead: a peer claims one,
seals a Welcome to it, and the invite dies on arrival on *their* side. `claimDmKeyPackage` now takes
the **newest** package for the same reason (changed 2026-09-01) — FIFO handed out the orphans first.

⚠️ **Deploying is what starts it**; there is no separate switch.

**Measured against production on 2026-09-01, before the first run:** 0 welcomes, 0 messages, 49
unclaimed packages across 3 subjects (20 / 19 / 10, all three days old) and 2 claimed tombstones. Every
rule therefore matches nothing — the 406-package backlog had already gone, to a hand-deletion of the
retired format plus the client's own retire-all path. So this ships as a **backstop, not a cleanup**,
and the first log line should read `retention sweep found nothing to do`. A first line carrying large
counts would itself be worth reading.

To run it locally, exactly as the platform does:

```bash
bunx wrangler dev --local --test-scheduled
curl "http://localhost:8799/__scheduled?cron=17+4+*+*+*"   # log line appears in the dev output
```

## Static assets

Everything under `public/` is served free from the edge (Workers Static Assets); matching
requests never invoke the Worker, and non-asset paths fall through to `src/worker.ts`.
Two uses, each with its own doc — read before adding files, since **anything in `public/`
is world-readable**:

- [`WELLKNOWN.md`](./WELLKNOWN.md) — passkey + universal-link association files.
- [`SHARED-PAGES.md`](./SHARED-PAGES.md) — semi-private HTML documents at `public/<uuid>/`,
  shared by link. Covers how to edit and redeploy one, and the caveats (obscurity is not
  access control; never create `public/index.html`).

## Run

```bash
bun run dev        # watch mode, port 3300
# env: PORT, AUTH_DOMAIN (default localhost:8081 = Expo web dev origin), MIDNIGHT_NETWORK (default preprod)
# chain: IDENTITY_CONTRACT_ADDRESS (`identity.compact` — logins, registration, /auth/config,
#        and the only contract address this service needs; unset disables the chain plane),
#        CHAIN (=0 disables), CHAIN_SEED, CHAIN_MAX_RETRIES,
#        CHAIN_DUST_STATE_FILE — dust-sync snapshot path; defaults to
#        .data/dust-state.preprod.gz on preprod (restarts skip the ~15-min cold sync),
#        off on other networks (the local chain is recreated per chain:up, and a snapshot
#        must not outlive its chain). Snapshot is seed-specific — delete when CHAIN_SEED changes.
#        Endpoints default per network (local standalone stack for `undeployed`, the
#        official preprod rail for `preprod`; proof server always local) — override with
#        CHAIN_INDEXER_URL, CHAIN_INDEXER_WS_URL, CHAIN_NODE_URL, CHAIN_NODE_WS_URL,
#        PROOF_SERVER_URL.
# preprod boot: IDENTITY_CONTRACT_ADDRESS=<addr> MIDNIGHT_NETWORK=preprod \
#                CHAIN_SEED=<sponsor seed> bun run dev
```

JWT keys are ephemeral per process (spike). Multi-instance deployment needs: shared nonce
store, persistent signing key (env/KMS), CORS narrowed to the app origin.

## Tests

`bun run test` from the repo root. The signature fixtures are produced the way a conforming
wallet signs — ledger-v8 WASM `signData` over the connector payload — so the tests exercise
the same bytes as the future 1AM E2E. Covers: happy path + JWT verify, nonce replay,
key/address mismatch (impersonation), message tampering, stale issued-at, wrong
domain/network.
