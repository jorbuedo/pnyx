// Entry point for the sponsor host (the VPS). Boots the sponsor wallet and nothing else.
//
// Run:
//   SPONSOR_TOKEN=<shared secret> CONTENT_ORIGIN=https://pnyx.pxkq.uk \
//   CHAIN_SEED=<sponsor seed> MIDNIGHT_NETWORK=preprod \
//   CHAIN_DUST_STATE_FILE=/var/lib/sponsor/dust-state.preprod.gz \
//   bun services/content/src/sponsor-server.ts
//
// Env: PORT (default 3400, loopback — see below), SPONSOR_TOKEN and CONTENT_ORIGIN and CHAIN_SEED
// (required), MIDNIGHT_NETWORK, CHAIN_DUST_STATE_FILE, CHAIN_INDEXER_URL / CHAIN_INDEXER_WS_URL /
// CHAIN_NODE_URL / CHAIN_NODE_WS_URL (endpoint overrides; unset uses the network's official rail),
// IDENTITY_CONTRACT_ADDRESS and CIRCLE_CODE_DIGEST (required — together they are the sponsorship
// policy; see below), SPONSOR_BACKLOG_FILE, SPONSOR_DUST_FLOOR (optional; below it `/status` reports
// `degraded` — unset means only a zero balance is called out, never an invented threshold),
// CHAIN_PROVER_KEYS_DIR (required in practice — see below), PROOF_SERVER_URL. CHAIN_SEED_FILE is
// preferred over CHAIN_SEED — see `sponsorSeed`. Either carries a BIP-39 mnemonic or a hex seed; the
// mnemonic is what the app can also restore, so the sponsor wallet is inspectable from the product.
//
// **Nothing on disk depends on the deployed contract.** No contract module and none of the contract's
// ZK artifacts: `balanceAndSubmitProven` reads neither, so a contract redeploy leaves this host
// untouched (`@pnyx/chain-client/sponsor-client`).
//
// It does need a **prover**, which is not the same claim. `balanceTx` adds unproven zswap/dust spend
// actions to bind the fee, and something has to prove them — by default an HTTP proof server. Rather
// than run one, this host proves in-process from mirrored key material for the four wallet circuits
// (`CHAIN_PROVER_KEYS_DIR`). That material is contract-independent, so the property above survives.
//
// **No inbound port.** It listens on 127.0.0.1 and `cloudflared` dials out, so the box needs no open
// port, no public IP and no certificate. The bearer token is still required — a tunnel is not
// authentication, and anything else on the host could otherwise reach the wallet.
import fs from 'node:fs';
import path from 'node:path';
import { masterSeedFrom } from '@pnyx/chain-client/master-seed';
import type { SectionSync, SponsorClient, SponsorStatus } from '@pnyx/chain-client/sponsor-client';
import { createSponsorClient } from '@pnyx/chain-client/sponsor-client';
import { isSponsorshipRefusal } from '@pnyx/chain-client/sponsorship';
import type { ProvenSettlement } from './chain.js';
import { createJournalLog, underSystemd } from './journal-log.js';
import type { ChainTx } from '@pnyx/chain-client/client';
import { SPONSOR_FAILURE_STATUS, sponsorFailure } from './sponsor-failure.js';
import { callbackSettlementSink } from './sponsor-callback.js';
import { guardNetwork } from './sponsor-network-guard.js';
import { createSponsorQueue } from './sponsor.js';
import { inviteAuthorityCommitmentFor, parseInviteAuthorityRoot } from './invite-authority.js';
import { createInviteMinter, inviteMinterReady } from './invite-mint.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
};

/**
 * The sponsor seed, preferring a file over an env var, as a **mnemonic or a hex seed**.
 *
 * `CHAIN_SEED` is accepted for local runs, but a seed in the environment is visible in
 * `docker inspect`, in `ps` output and in anything that dumps the environment on a crash — for the one
 * secret this host holds, a mounted file read once at boot is the better default. `CHAIN_SEED_FILE`
 * wins when both are set.
 *
 * Either format is accepted, and which one it is decides which wallet this host becomes — so the
 * format is logged and a malformed one refuses the boot rather than syncing an empty wallet
 * (`@pnyx/chain-client/master-seed`).
 */
const sponsorSeed = (): { readonly masterSeed: string; readonly summary: string; readonly from: string } => {
  const file = process.env.CHAIN_SEED_FILE;
  const read = (): { text: string; from: string } => {
    if (file !== undefined && file !== '') {
      try {
        return { text: fs.readFileSync(file, 'utf8'), from: `CHAIN_SEED_FILE ${file}` };
      } catch (error) {
        console.error(`could not read CHAIN_SEED_FILE ${file}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }
    return { text: required('CHAIN_SEED'), from: 'CHAIN_SEED' };
  };
  const { text, from } = read();
  const seed = masterSeedFrom(text);
  if (!seed.ok) {
    console.error(`${from} holds ${seed.reason}`);
    process.exit(1);
  }
  return { masterSeed: seed.masterSeed, summary: seed.summary, from };
};

const port = Number(process.env.PORT ?? 3400);
const token = required('SPONSOR_TOKEN');
const originUrl = required('CONTENT_ORIGIN');
// What this sponsor pays for. **Policy, not plumbing**: two 64-hex values, no build output and nothing
// per-deployment on disk. Both required — a sponsor with no policy would pay for any proven transaction
// anyone sends, including one against an unrelated contract (`docs/ABUSE_MITIGATION.md` §1).
//
// A **code digest** per template, because neither kind has an address this host can know: there is one
// contract per circle *and* one per identity, each at an address derived from arguments this host never
// sees. The digest recognises any of them from the verifier keys their `operations` map carries, and it
// is a fact about the compiled template rather than about a deployment — so it survives every deploy and
// changes on exactly the event that should invalidate it, a recompile. Both values are the `codeDigest`
// the artifacts manifest reports for the build the devices prove against
// (`<artifacts>/identity/manifest.json`, `<artifacts>/circle/manifest.json`).
//
// ⚠️ `IDENTITY_CONTRACT_ADDRESS` used to be here and is gone: with one contract per identity it could
// only ever have funded one person's identity while refusing everybody else's.
const identityCodeDigest = required('IDENTITY_CODE_DIGEST');
const circleCodeDigest = required('CIRCLE_CODE_DIGEST');
// The permit contract and the name template. Optional, unlike the two above: a deployment that has not
// reached handles yet is a real composition, and refusing to boot over it would be inventing a
// dependency. Absent → those calls are refused, which is what "no handles here" means.
const paymentCodeDigest = process.env.PAYMENT_CODE_DIGEST ?? '';
const handleCodeDigest = process.env.HANDLE_CODE_DIGEST ?? '';
// `proposal.compact` — one contract per proposal, and a *deploy* is how one is created. Optional for
// the same reason the two above are: a deployment that has not published proposal artifacts is a real
// composition, and it should refuse votes rather than refuse to boot.
//
// ⚠️ It has to be its own value. Until 2026-09-10 `castVote`/`revealVote` were listed under the
// circle's entry points, where they matched no contract and funded nothing, and a proposal deploy
// matched no template at all — so both halves of a vote were refused with nothing naming the cause.
const proposalCodeDigest = process.env.PROPOSAL_CODE_DIGEST ?? '';
const network = process.env.MIDNIGHT_NETWORK ?? 'preprod';

/**
 * The invite minter, or the reason there isn't one.
 *
 * Four things have to be present and any of them may reasonably be absent, so this resolves once at
 * boot and the routes report the reason rather than a bare 404. ⚠️ **`INVITE_AUTHORITY_ROOT` is the
 * one secret on this box besides the wallet seed**: it derives every circle's invite authority, so a
 * leak is every gated circle that delegated to this deployment — which is also why it is per circle
 * and not one authority shared across them (`invite-authority.ts`).
 */
const txgenBinary = process.env.MIDNIGHT_TXGEN_BIN ?? '';
const circleArtifactsDir = process.env.CIRCLE_ARTIFACTS_DIR ?? '';
// The SRS the prover asks for by K. Defaults beside the wallet circuits' keys, which is where
// `deploy/fetch-prover-keys.sh` already mirrors it — one directory of key material, not two.
const zkParamsDir =
  process.env.MIDNIGHT_PARAMS_DIR ??
  (process.env.CHAIN_PROVER_KEYS_DIR === undefined ? '' : path.join(process.env.CHAIN_PROVER_KEYS_DIR, 'params'));

const { minter, minterReason, inviteAuthorityRoot } = ((): {
  minter: ReturnType<typeof createInviteMinter> | null;
  minterReason: string | null;
  // Published even when minting is unavailable: a founder can delegate to a commitment this host will
  // be able to use once its artifacts are mirrored, and refusing to name it would make the two
  // failures look like one.
  inviteAuthorityRoot: Uint8Array | null;
} => {
  const rawRoot = process.env.INVITE_AUTHORITY_ROOT;
  if (rawRoot === undefined || rawRoot === '') {
    return { minter: null, minterReason: 'INVITE_AUTHORITY_ROOT is not set', inviteAuthorityRoot: null };
  }
  const parsed = parseInviteAuthorityRoot(rawRoot);
  if (!parsed.ok) {
    // Refused, never truncated or padded. A root of the wrong length derives secrets that look fine
    // and are simply not the ones any circle committed to, and every mint would then fail as "not the
    // invite authority" — a sentence about the contract, several layers from the typo that caused it.
    return { minter: null, minterReason: parsed.message, inviteAuthorityRoot: null };
  }
  if (txgenBinary === '' || circleArtifactsDir === '' || zkParamsDir === '') {
    return {
      minter: null,
      minterReason: 'MIDNIGHT_TXGEN_BIN, CIRCLE_ARTIFACTS_DIR and a params directory are all required to mint',
      inviteAuthorityRoot: parsed.root,
    };
  }
  const files = inviteMinterReady({
    binary: txgenBinary,
    artifactsDir: circleArtifactsDir,
    paramsDir: zkParamsDir,
    circleCodeDigest,
  });
  if (!files.ok) {
    return {
      minter: null,
      minterReason:
        'missing' in files
          ? `missing: ${files.missing.join(', ')}`
          : `the mirrored circle artifacts are compile ${files.stale.mirrored.slice(0, 12)}… but this sponsor funds ` +
            `${files.stale.configured.slice(0, 12)}… — re-run deploy/push-invite-minter.sh`,
      inviteAuthorityRoot: parsed.root,
    };
  }
  return {
    minter: createInviteMinter({
      binary: txgenBinary,
      artifactsDir: circleArtifactsDir,
      paramsDir: zkParamsDir,
      root: parsed.root,
      network,
      log: (message) => log(message),
    }),
    minterReason: null,
    inviteAuthorityRoot: parsed.root,
  };
})();


// Plain sends. Off unless explicitly turned on: it is the one sponsorship clause not bounded by our own
// contracts, so it is a deployment decision rather than a default (docs/ABUSE_MITIGATION.md).
const fundTransfers = process.env.SPONSOR_FUND_TRANSFERS === '1';
// Levelled, so `journalctl -p warning -u sponsor.service` shows the failures and not a balance readout.
// `log` stays the plain info sink the chain client's single `log` callback expects.
const journal = createJournalLog('sponsor', { underSystemd: underSystemd(process.env) });
const log = journal.info;

/**
 * Boot state, so a status read can tell "still syncing" from "dead".
 *
 * Everything below the wallet used to be built at module scope behind a top-level `await`, which meant
 * `Bun.serve` did not run until the sections were synced — 34 minutes on a snapshot-less preprod boot,
 * during which the port simply refused connections. Silence is not a signal: it reads the same as a
 * crashed process, which is why the runbook says `/health` cannot be a startup probe. Serving first
 * turns that window into `503 {status: 'starting'}` carrying live sync progress.
 */
type Ready = {
  readonly client: SponsorClient;
  readonly queue: ReturnType<typeof createSponsorQueue>;
  /** Resolves where the job landed, or rejects with why it did not. `undefined` for an identity
   *  row, whose outcome `submitIdentityRow` already reported to its own caller. */
  readonly accept: (job: Job) => Promise<ChainTx | undefined>;
};
let ready: Ready | null = null;
let bootFailure: string | null = null;
let syncProgress: { unshielded: SectionSync; dust: SectionSync } | null = null;
const startedAt = Date.now();

/**
 * Outcome counters. The load-bearing part is the *ordering* of the last success and the last failure:
 * a host that has failed everything since its last success is broken however healthy each individual
 * field looks — and that is the only signal that catches the missing-prover-keys class, where nothing
 * is wrong until a real transaction reaches `balanceTx`.
 */
const counts = { submitted: 0, refused: 0, failed: 0 };
let lastSuccessAt: number | null = null;
let lastFailure: { at: number; message: string } | null = null;

const noteSuccess = () => {
  counts.submitted += 1;
  lastSuccessAt = Date.now();
};
const noteRefusal = () => {
  counts.refused += 1;
};
const noteFailure = (message: string) => {
  counts.failed += 1;
  lastFailure = { at: Date.now(), message };
};

const bootClient = () => {
  const seed = sponsorSeed();
  log(`sponsor seed read from ${seed.from}: a ${seed.summary}`);
  log(`plain transfers are ${fundTransfers ? 'FUNDED (SPONSOR_FUND_TRANSFERS=1)' : 'not funded'}`);
  return createSponsorClient({
    seed: seed.masterSeed,
    network,
    identityCodeDigest,
    circleCodeDigest,
    proposalCodeDigest,
    paymentCodeDigest,
    handleCodeDigest,
    fundTransfers,
    log: (message) => log(message),
    ...(process.env.CHAIN_INDEXER_URL !== undefined && { indexer: process.env.CHAIN_INDEXER_URL }),
    ...(process.env.CHAIN_INDEXER_WS_URL !== undefined && { indexerWS: process.env.CHAIN_INDEXER_WS_URL }),
    ...(process.env.CHAIN_NODE_URL !== undefined && { node: process.env.CHAIN_NODE_URL }),
    ...(process.env.CHAIN_NODE_WS_URL !== undefined && { nodeWS: process.env.CHAIN_NODE_WS_URL }),
    // Balancing proves, so a prover is not optional. This host runs no proof server, so it proves
    // in-process from mirrored key material — `deploy/fetch-prover-keys.sh` puts it there.
    ...(process.env.CHAIN_PROVER_KEYS_DIR !== undefined && { proverKeysDir: process.env.CHAIN_PROVER_KEYS_DIR }),
    ...(process.env.PROOF_SERVER_URL !== undefined && { proofServer: process.env.PROOF_SERVER_URL }),
    retry: { maxRetries: Number(process.env.CHAIN_MAX_RETRIES ?? 3) },
    // A cold preprod sync walks >1.2M dust events (~15 min); the snapshot is what makes a restart
    // cheap. Without it every deploy costs that sync before the first transaction can be balanced.
    ...(process.env.CHAIN_DUST_STATE_FILE !== undefined
      ? { dustStateFile: process.env.CHAIN_DUST_STATE_FILE }
      : network === 'preprod'
        ? { dustStateFile: path.resolve(import.meta.dirname, `../.data/dust-state.${network}.gz`) }
        : {}),
    onSyncProgress: (progress) => {
      syncProgress = progress;
    },
  });
};

/**
 * Jobs accepted but not yet submitted, so a restart mid-flight does not silently drop a user's
 * transaction. Written before the job is enqueued and removed once the queue reports it settled.
 *
 * Deliberately a file rather than a database: the only state on this host is "what have I promised to
 * submit", it is small, and a box whose job is holding a wallet should not also need a DB to babysit.
 */
const backlogFile = process.env.SPONSOR_BACKLOG_FILE ?? path.resolve(import.meta.dirname, '../.data/sponsor-backlog.json');
type Job = {
  readonly id: string;
  readonly settlement: ProvenSettlement | null;
  readonly txB64: string;
  /** The originating `cf-ray`, kept so a job replayed after a restart still logs under its request. */
  readonly requestId?: string;
};

const readBacklog = (): Job[] => {
  try {
    return JSON.parse(fs.readFileSync(backlogFile, 'utf8')) as Job[];
  } catch {
    return [];
  }
};
const writeBacklog = (jobs: Job[]) => {
  fs.mkdirSync(path.dirname(backlogFile), { recursive: true });
  fs.writeFileSync(backlogFile, JSON.stringify(jobs, null, 2));
};
let backlog = readBacklog();
const remember = (job: Job) => {
  backlog = [...backlog, job];
  writeBacklog(backlog);
};
const forget = (id: string) => {
  backlog = backlog.filter((j) => j.id !== id);
  writeBacklog(backlog);
};

const decode = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'));

/**
 * Every message in an error's `cause` chain.
 *
 * The wallet SDK reports a failed balance as a bare `Failed to prove transaction` and puts what
 * actually went wrong — a refused connection, an HTTP status — in `cause`. Reading only the top
 * message turns a one-line diagnosis into a hunt.
 */
const explain = (error: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' ← ');
};

const makeAccept =
  (queue: ReturnType<typeof createSponsorQueue>) =>
  (job: Job): Promise<ChainTx | undefined> => {
    remember(job);
    const req = job.requestId === undefined ? '' : ` req=${job.requestId}`;
    if (job.settlement === null) {
      void queue
        .submitIdentityRow(decode(job.txB64), job.requestId)
        .then(({ txId, blockHeight }) => {
          noteSuccess();
          log(`replayed identity row on chain (tx=${txId} block=${blockHeight}${req})`);
          forget(job.id);
        })
        .catch((error: unknown) => {
          noteFailure(explain(error));
          journal.error(`replayed identity row failed${req}: ${explain(error)}`);
          forget(job.id);
        });
      return Promise.resolve(undefined);
    }
    const submitted = queue.submitProven(job.settlement, decode(job.txB64), job.requestId);
    // ⚠️ A handler here, and the same promise returned. Callers that do not wait (every settlement
    // kind but a transfer) must not raise an unhandled rejection; a caller that does wait still sees
    // the rejection, because attaching this handler does not consume the original.
    void submitted.catch(() => undefined);
    void queue.whenIdle().then(() => forget(job.id));
    return submitted;
  };

/**
 * Bring the wallet up, then start accepting work. Runs *after* `Bun.serve`, so the long cold sync is
 * observable rather than silent; until it resolves every route answers 503.
 */
const boot = async (): Promise<void> => {
  try {
    const client = await bootClient();
    const sink = callbackSettlementSink({ originUrl, token, log });
    const queue = createSponsorQueue(client, sink, log);
    const accept = makeAccept(queue);
    ready = { client, queue, accept };
    syncProgress = null;
    log(`wallet ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // A transaction we accepted is a promise, and the client is long gone. Replayed once the wallet
    // can actually submit — before that there is nothing to replay onto.
    if (backlog.length > 0) {
      log(`replaying ${backlog.length} accepted job(s) from a previous run`);
      const pending = backlog;
      backlog = [];
      writeBacklog(backlog);
      for (const job of pending) accept(job);
    }
  } catch (error) {
    // Kept and served rather than exiting: systemd would restart into the same failure, and a box that
    // answers "my wallet would not start, here is why" is worth more than one that refuses connections.
    bootFailure = explain(error);
    journal.error(`wallet failed to start: ${bootFailure}`);
  }
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let jobSeq = 0;

/**
 * Optional DUST floor, in the smallest unit. Below it the host is reported `degraded` — it can still
 * sponsor, but not for long. Unset means precisely "no floor is configured", and then only true
 * exhaustion (a zero balance) is reported; no threshold is invented on the host's behalf.
 */
const dustFloor = process.env.SPONSOR_DUST_FLOOR === undefined ? null : BigInt(process.env.SPONSOR_DUST_FLOOR);

/**
 * One word for a checker that should not have to know the rules.
 *
 * - `starting` — the wallet is still syncing. Not an error; the only honest answer during a cold sync.
 * - `failing`  — cannot sponsor anything: the wallet never started, or DUST is exhausted.
 * - `degraded` — still serving, but something is wrong: a section behind, a DUST floor crossed, a
 *   backlog that has not drained, or nothing succeeding since the last failure.
 * - `ok`       — synced, funded, and the last thing that happened was not a failure.
 */
type Rollup = 'starting' | 'ok' | 'degraded' | 'failing';

const rollup = (status: SponsorStatus | null): { state: Rollup; reasons: string[] } => {
  if (bootFailure !== null) return { state: 'failing', reasons: [`wallet failed to start: ${bootFailure}`] };
  if (status === null) return { state: 'starting', reasons: ['wallet is syncing'] };

  const reasons: string[] = [];
  const dust = BigInt(status.balances.dust);
  if (dust === 0n) {
    return { state: 'failing', reasons: ['DUST is exhausted; every sponsorship will fail'] };
  }
  if (dustFloor !== null && dust < dustFloor) reasons.push(`DUST ${dust} is below the floor ${dustFloor}`);
  // `lag` is null until the section reports an index; "catching up" is the honest phrasing then, and
  // interpolating the null would have printed "behind by null".
  const behind = (name: string, lag: string | null) => (lag === null ? `${name} section catching up` : `${name} section behind by ${lag}`);
  if (!status.sync.unshielded.complete) reasons.push(behind('unshielded', status.sync.unshielded.lag));
  if (!status.sync.dust.complete) reasons.push(behind('dust', status.sync.dust.lag));
  if (backlog.length > 0) reasons.push(`${backlog.length} job(s) accepted but not settled`);
  // Ordering, not counts: one failure long ago followed by successes is a healthy host.
  if (lastFailure !== null && (lastSuccessAt === null || lastFailure.at > lastSuccessAt)) {
    reasons.push(`nothing has succeeded since the last failure: ${lastFailure.message}`);
  }
  return { state: reasons.length === 0 ? 'ok' : 'degraded', reasons };
};

const statusBody = async () => {
  // A status read that fails is reported as `starting`, which is indistinguishable from a cold sync —
  // so it has to say so somewhere.
  const wallet =
    ready === null
      ? null
      : await ready.client.status().catch((error: unknown) => {
          journal.warn(`status read failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
  const { state, reasons } = rollup(wallet);
  return {
    status: state,
    reasons,
    network,
    identityCodeDigest,
    circleCodeDigest,
    proposalCodeDigest,
    paymentCodeDigest,
    handleCodeDigest,
    // Whether this host can mint invites at all, and why not when it cannot. Reported rather than
    // inferred from a 404: "the artifacts are not mirrored" and "no circle has delegated to us" are
    // different states and only one of them is ours to fix.
    invites: minter === null ? { minting: false, reason: minterReason } : { minting: true, reason: null },
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    queued: backlog.length,
    submissions: {
      ...counts,
      lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
      lastFailure:
        lastFailure === null ? null : { at: new Date(lastFailure.at).toISOString(), message: lastFailure.message },
    },
    // Present only while syncing; `wallet` is the same shape once the sections are up.
    ...(wallet === null ? { syncing: syncProgress } : { wallet }),
  };
};

const handler = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/health') {
    // Deliberately still cheap, still unauthenticated, and still only liveness — but no longer a
    // green light during a boot that has not finished, which is what made it misleading.
    const live = ready !== null;
    return json(
      { ok: live, status: live ? 'ok' : bootFailure !== null ? 'failing' : 'starting', network, identityCodeDigest, circleCodeDigest, queued: backlog.length },
      live ? 200 : 503,
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    return json({ error: 'unauthorized' }, 401);
  }
  // Behind the token: a DUST balance is a funding signal, and "the sponsor is broke" is an invitation.
  if (request.method === 'GET' && pathname === '/status') {
    const body = await statusBody();
    return json(body, body.status === 'starting' ? 503 : 200);
  }
  if (request.method !== 'POST') {
    return json({ error: 'not found' }, 404);
  }

  // The Worker's `cf-ray`, so one action reads as one action across two log systems. Absent on a direct
  // call (a local probe, a `curl` on the box), and then simply omitted rather than invented.
  const requestId = request.headers.get('x-request-id') ?? undefined;
  const req = requestId === undefined ? '' : ` req=${requestId}`;

  // ⚠️ **Above the sync guard, deliberately.** Delegating is the first thing a founder does and it is
  // a pure derivation on our side — refusing it for 35 minutes while the wallet cold-syncs would block
  // setup on a wallet the setup does not use.
  if (pathname === '/internal/invite-authority') {
    if (inviteAuthorityRoot === null) {
      return json({ error: `this host holds no invite authority: ${minterReason ?? 'not configured'}` }, 404);
    }
    const ask = (await request.json().catch(() => ({}))) as { circleId?: unknown };
    if (typeof ask.circleId !== 'string' || ask.circleId === '') {
      return json({ error: 'circleId is required' }, 400);
    }
    return json({
      commitment: inviteAuthorityCommitmentFor(inviteAuthorityRoot, ask.circleId),
      // Whether we could actually use it yet. A founder delegating to a host that cannot mint has
      // configured something real that does not work, which is worth saying at the moment they do it.
      minting: minter !== null,
      reason: minterReason,
    });
  }

  if (ready === null) {
    // The Worker surfaces this to the caller, so it has to say which of the two it is.
    return json(
      { error: bootFailure === null ? 'sponsor wallet is still syncing' : `sponsor wallet failed to start: ${bootFailure}` },
      503,
    );
  }

  // Minting an invite: the host builds and proves the contract call itself, so nothing here parses a
  // transaction out of the body. It is the one route on this box that reads chain state before writing.
  if (pathname === '/internal/issue-invite') {
    if (minter === null) {
      return json({ error: `this host cannot mint invites: ${minterReason ?? 'not configured'}` }, 404);
    }
    const client = ready.client;
    const ask = (await request.json().catch(() => ({}))) as {
      circleId?: unknown;
      contractAddress?: unknown;
      commitment?: unknown;
      active?: unknown;
    };
    const circleId = typeof ask.circleId === 'string' ? ask.circleId : '';
    const contractAddress = typeof ask.contractAddress === 'string' ? ask.contractAddress.toLowerCase() : '';
    const commitment = typeof ask.commitment === 'string' ? ask.commitment.toLowerCase() : '';
    if (circleId === '' || !/^[0-9a-f]{64}$/.test(contractAddress) || !/^[0-9a-f]{64}$/.test(commitment)) {
      return json({ error: 'circleId, a 64-hex contractAddress and a 64-hex commitment are required' }, 400);
    }
    // `active` defaults to issuing rather than being required: revoking is the rarer half and a
    // missing flag meaning "revoke" would be the worse accident of the two.
    const active = ask.active === undefined ? true : ask.active === true;
    const startedAt = Date.now();
    try {
      // Read first. The transcript runs against the circle's live ledger state, so a stale read is a
      // transaction the ledger rejects rather than a wrong answer — and "nothing is deployed there"
      // has to be its own message, or it arrives as a Rust panic about a short file.
      const contractState = await client.contractState(contractAddress);
      if (contractState === undefined) {
        return json({ error: `no contract is deployed at ${contractAddress}` }, 400);
      }
      const tx = await minter.mint({
        contentCircleId: circleId,
        contractAddressHex: contractAddress,
        contractState,
        commitmentHex: commitment,
        active,
      });
      // Awaited, exactly as `/internal/register` is and for the same reason: the caller is holding a
      // user's request open and about to hand them a code. A code returned before its commitment is on
      // chain is one that fails at `join` with "no such invite", which the recipient cannot act on.
      const { txId, blockHeight } = await client.submitProven(tx);
      noteSuccess();
      log(`invite ${commitment.slice(0, 8)}… ${active ? 'issued' : 'revoked'} for circle ${circleId} (tx=${txId} block=${blockHeight} in ${Date.now() - startedAt}ms${req})`);
      return json({ issued: true, txId, blockHeight }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refused = isSponsorshipRefusal(error);
      const elapsed = `in ${Date.now() - startedAt}ms${req}`;
      if (refused) {
        noteRefusal();
        journal.warn(`invite refused (${elapsed}): ${explain(error)}`);
      } else {
        noteFailure(explain(error));
        journal.error(`invite failed (${elapsed}): ${explain(error)}`);
      }
      // Same status split as `/internal/register`: a refusal is 400, whose body survives the tunnel,
      // and a genuine failure is 200 + `ok:false` because Cloudflare replaces a 5xx body from a tunnel
      // origin with its own error page (`sponsor-failure.ts`).
      return refused
        ? json({ error: `issue-invite refused: ${message}` }, 400)
        : json(sponsorFailure(`issue-invite failed: ${message}`), SPONSOR_FAILURE_STATUS);
    }
  }

  const body = (await request.json().catch(() => ({}))) as { tx?: unknown; settlement?: unknown };
  if (typeof body.tx !== 'string' || body.tx === '') {
    return json({ error: 'tx is required (base64 proven transaction)' }, 400);
  }

  // ⚠️ **Before either route accepts anything.** A transaction for another network used to be taken,
  // queued and refused deep inside `balanceTx` — `invalid network ID - expect 'preview' found 'preprod'`
  // in this host's journal, minutes after the caller was told `accepted`. One-sided and cheap; the
  // ledger still has the last word (`sponsor-network-guard.ts`).
  const belongsHere = guardNetwork(decode(body.tx), network);
  if (!belongsHere.ok) {
    journal.warn(`refused ${pathname}: ${belongsHere.message}${req}`);
    return json({ error: belongsHere.message }, 400);
  }

  if (pathname === '/internal/register') {
    // Awaited: the caller is relaying a user's registration and needs to know it is going on chain.
    const startedAt = Date.now();
    try {
      const { txId, blockHeight } = await ready.queue.submitIdentityRow(decode(body.tx), requestId);
      // The transaction id is the only handle on a sponsored registration — there is no ChainRef row to
      // carry it — and the elapsed time is how in-process proving on 2 vCPU gets measured at all.
      noteSuccess();
      log(`identity row on chain (tx=${txId} block=${blockHeight} in ${Date.now() - startedAt}ms${req})`);
      return json({ registered: true }, 202);
    } catch (error) {
      // A refusal is the caller's bytes, not a gateway failure — 400, whose body survives the tunnel.
      // A genuine failure answers 200 with `ok: false` for the same reason and no other: Cloudflare
      // replaces the body of any 5xx from a tunnel origin with its own "error code: 502" page. See
      // `sponsor-failure.ts` for the decision and the alternative that was rejected.
      //
      // Logged as well as answered, because a genuine failure *cannot* be reclassified to a status whose
      // body survives — and `createTxSubmitter` rethrows a non-retryable error without logging it, so this
      // is the only place a balance/submit rejection is recorded at all.
      //
      // A refusal is `warn`, not `error`: the caller sent bytes we will not pay for, which is the policy
      // working. A failure is ours to fix.
      const message = error instanceof Error ? error.message : String(error);
      const refused = isSponsorshipRefusal(error);
      const elapsed = `in ${Date.now() - startedAt}ms${req}`;
      if (refused) {
        noteRefusal();
        journal.warn(`identity row refused (${elapsed}): ${explain(error)}`);
      } else {
        noteFailure(explain(error));
        journal.error(`identity row failed (${elapsed}): ${explain(error)}`);
      }
      return refused
        ? json({ error: `register failed: ${message}` }, 400)
        : json(sponsorFailure(`register failed: ${message}`), SPONSOR_FAILURE_STATUS);
    }
  }

  if (pathname === '/internal/submit') {
    if (typeof body.settlement !== 'object' || body.settlement === null) {
      return json({ error: 'settlement is required' }, 400);
    }
    jobSeq += 1;
    const settlement = body.settlement as ProvenSettlement;
    const job = {
      id: `job-${Date.now()}-${jobSeq}`,
      settlement,
      txB64: body.tx,
      ...(requestId === undefined ? {} : { requestId }),
    };
    /**
     * ⚠️ **A transfer is awaited; every other kind is not.**
     *
     * The others settle a ChainRef row the app already reads, so a refusal reaches it either way. A
     * transfer has no row — the device's pending-send is written *because* this answered 202 — so
     * acking on enqueue meant a transfer the node refused showed as "Pending" on the device until its
     * input lock expired an hour later, with the failure visible only in this host's journal
     * (observed 2026-09-30, preprod). The origin already awaits this call for transfers; it was
     * waiting on a promise that resolved as soon as the bytes were queued.
     */
    if (settlement.kind === 'transfer') {
      try {
        const tx = await ready.accept(job);
        return json({ accepted: true, ...(tx === undefined ? {} : { txId: tx.txId, blockHeight: tx.blockHeight }) }, 202);
      } catch (error) {
        // 200 + `ok:false`, not a 5xx: the tunnel replaces a 5xx body, and the reason is the whole
        // point of answering at all (`sponsor-failure.ts`).
        return json(sponsorFailure(`submit failed: ${explain(error)}`), SPONSOR_FAILURE_STATUS);
      }
    }
    void ready.accept(job);
    return json({ accepted: true }, 202);
  }

  return json({ error: 'not found' }, 404);
};

// Loopback only. cloudflared connects outward to Cloudflare, so nothing needs to reach this port
// from outside the host.
Bun.serve({ port, hostname: '127.0.0.1', fetch: handler });
log(
  `sponsor service on 127.0.0.1:${port} (network=${network}, ` +
    `identity code=${identityCodeDigest.slice(0, 12)}…, circle code=${circleCodeDigest.slice(0, 12)}…, ` +
    `proposal code=${proposalCodeDigest === '' ? 'unset' : `${proposalCodeDigest.slice(0, 12)}…`}, ` +
    `payment code=${paymentCodeDigest === '' ? 'unset' : `${paymentCodeDigest.slice(0, 12)}…`}, ` +
    `handle code=${handleCodeDigest === '' ? 'unset' : `${handleCodeDigest.slice(0, 12)}…`}, origin=${originUrl})`,
);
// Said at boot rather than discovered at the first claim: a host that cannot mint looks identical to
// one no circle has delegated to, and only the first is ours to fix.
log(minter === null ? `invite minting is OFF (${minterReason ?? 'not configured'})` : 'invite minting is on');

// Serving already; this is what makes the sync observable instead of silent.
void boot();
