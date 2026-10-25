// Entry point: bun src/server.ts (or bun run dev for watch mode).
// Env: PORT (default 3300), AUTH_DOMAIN (default localhost:8081 — the Expo web dev
// origin), MIDNIGHT_NETWORK (default preprod), DEV_AUTH (default 1 — wallet-less login;
// set DEV_AUTH=0 for anything public), DATA_FILE (default .data/content.json).
//
// Chain mirroring: enabled automatically when ../../.local-deploy.json exists (written by
// `bun run e2e:local`) or when IDENTITY_CONTRACT_ADDRESS is set. CHAIN=0 disables it explicitly.
// Preprod: IDENTITY_CONTRACT_ADDRESS=<addr> MIDNIGHT_NETWORK=preprod is enough — endpoints default
// to the official preprod rail (proof server stays local). CHAIN_INDEXER_URL /
// CHAIN_INDEXER_WS_URL / CHAIN_NODE_URL / CHAIN_NODE_WS_URL / PROOF_SERVER_URL override.
// On preprod the dust sync state is snapshotted to .data/dust-state.preprod.gz so restarts
// skip the ~15-min cold sync; CHAIN_DUST_STATE_FILE overrides the path (any network).
// JWT keys are ephemeral per process for the spike; public key at /.well-known/jwks.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChainClient } from '@pnyx/chain-client/client';
import { masterSeedFrom } from '@pnyx/chain-client/master-seed';
import { type ArtifactService, createArtifactService } from './artifacts.js';
import { createJwtKeys } from './auth.js';
import { type ChainMirror, createChainMirror, disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createMemoryRateLimiter } from './rate-limit.js';
import { createNotifier } from './notifications.js';
import { createPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const port = Number(process.env.PORT ?? 3300);
const domain = process.env.AUTH_DOMAIN ?? 'localhost:8081';
const devAuth = process.env.DEV_AUTH !== '0';
const dataFile = process.env.DATA_FILE ?? path.resolve(here, '../.data/content.json');

const localDeployFile = path.resolve(repoRoot, '.local-deploy.json');
const localDeploy = fs.existsSync(localDeployFile)
  ? (JSON.parse(fs.readFileSync(localDeployFile, 'utf8')) as { network: string; identityAddress?: string })
  : undefined;
// The identity contract is the only address this service needs. A circle is one contract per circle
// at an address derived from its own arguments, and nothing here writes to one — the device proves
// and this service balances + submits (`docs/CONTRACT_MIGRATION.md`).
const identityContractAddress = process.env.IDENTITY_CONTRACT_ADDRESS ?? localDeploy?.identityAddress;
const chainEnabled = process.env.CHAIN !== '0' && identityContractAddress !== undefined;
const network = process.env.MIDNIGHT_NETWORK ?? (chainEnabled ? (localDeploy?.network ?? 'undeployed') : 'preprod');

/**
 * The chain-mirror wallet's seed — a BIP-39 mnemonic or a hex seed, same contract as the sponsor host
 * (`sponsor-server.ts`). The default is the local standalone chain's genesis seed, which is why this
 * path stays dev-only; a malformed `CHAIN_SEED` refuses the boot instead of mirroring from a wallet
 * nobody meant to use.
 */
const chainSeed = (): string => {
  const seed = masterSeedFrom(
    process.env.CHAIN_SEED ?? '0000000000000000000000000000000000000000000000000000000000000001',
  );
  if (!seed.ok) {
    console.error(`CHAIN_SEED holds ${seed.reason}`);
    process.exit(1);
  }
  console.log(`chain mirror: seed is a ${seed.summary}`);
  return seed.masterSeed;
};

const { privateKey, publicJwk, kid } = await createJwtKeys();

// The Node server (local chain-mirror dev, /chain/*) uses the JSON-file store.
// The production content plane runs as the D1-backed Worker (src/worker.ts) on
// pnyx.pxkq.uk.
const store = createContentStore({ file: dataFile });

const managedDir = path.resolve(repoRoot, 'contract/managed');
/** The compiled contracts the device proves against, each with its own circuits and keys. */
const ARTIFACT_TARGETS = ['identity', 'circle'] as const;
let chain: ChainMirror = disabledChainMirror;
let artifacts: Record<string, ArtifactService> | undefined;
if (chainEnabled && identityContractAddress) {
  console.log(`chain mirror: identity contract ${identityContractAddress} on ${network}…`);
  // KZG SRS cache: the MidnightDataProvider layout ($MIDNIGHT_PP or ~/.cache/midnight/zk-params).
  const paramsDir = process.env.MIDNIGHT_PP ?? path.join(process.env.HOME ?? '', '.cache/midnight/zk-params');
  // One service per target, keyed by the compiled code rather than by a deployment: a circle's keys
  // have to be servable before its contract exists (docs/CONTRACT_MIGRATION.md).
  artifacts = Object.fromEntries(
    ARTIFACT_TARGETS.map((target) => [
      target,
      createArtifactService(path.join(managedDir, target), target, paramsDir),
    ]),
  );
  for (const target of ARTIFACT_TARGETS) {
    const m = artifacts[target]?.manifest();
    console.log(`chain artifacts: ${target} code ${m?.codeDigest.slice(0, 12)}… (${Object.keys(m?.circuits ?? {}).length} circuits)`);
  }
  const paramKs = Object.keys(artifacts[ARTIFACT_TARGETS[0]]?.manifest().params ?? {});
  console.log(`chain artifacts: ${paramKs.length ? `SRS for K ∈ {${paramKs.join(', ')}}` : `no SRS found in ${paramsDir}`}`);
  const client = await createChainClient({
    identity: {
      contractAddress: identityContractAddress,
      modulePath: path.resolve(repoRoot, 'contract/managed/identity/contract/index.js'),
    },
    seed: chainSeed(),
    network,
    // Endpoint overrides; unset → createChainClient's per-network defaults (local
    // standalone stack for `undeployed`, the official preprod rail for `preprod`).
    ...(process.env.CHAIN_INDEXER_URL !== undefined && { indexer: process.env.CHAIN_INDEXER_URL }),
    ...(process.env.CHAIN_INDEXER_WS_URL !== undefined && { indexerWS: process.env.CHAIN_INDEXER_WS_URL }),
    ...(process.env.CHAIN_NODE_URL !== undefined && { node: process.env.CHAIN_NODE_URL }),
    ...(process.env.CHAIN_NODE_WS_URL !== undefined && { nodeWS: process.env.CHAIN_NODE_WS_URL }),
    ...(process.env.PROOF_SERVER_URL !== undefined && { proofServer: process.env.PROOF_SERVER_URL }),
    // Each rebuild blocks the event loop with WASM work; CHAIN_MAX_RETRIES=0 disables
    // in-process retries.
    retry: { maxRetries: Number(process.env.CHAIN_MAX_RETRIES ?? 3) },
    // Dust-state snapshots default on for preprod only: the local standalone chain is
    // recreated by every `chain:up`, and a snapshot outliving its chain restores state
    // that no longer matches the ledger. The filename carries the network for the same
    // reason. CHAIN_DUST_STATE_FILE overrides (any network).
    ...(process.env.CHAIN_DUST_STATE_FILE !== undefined
      ? { dustStateFile: process.env.CHAIN_DUST_STATE_FILE }
      : network === 'preprod'
        ? { dustStateFile: path.resolve(here, `../.data/dust-state.${network}.gz`) }
        : {}),
  });
  chain = createChainMirror(client, store, identityContractAddress, (message) => console.log(`[chain] ${message}`));
  console.log('chain mirror: ready');
}

// Push notifications: intents + fan-out are always on; the sender is FCM only when
// FIREBASE_SERVICE_ACCOUNT is set (no Firebase project yet → logging dry-run sender).
const pushSender = await createPushSender((message) => console.log(`[push] ${message}`));
console.log(`push sender: ${pushSender.name}`);
const notify = createNotifier(store, pushSender, (message) => console.log(`[push] ${message}`));

// A self-hosted instance is not open just because it is not behind Cloudflare. Five per minute per
// caller: registration legitimately happens once or twice per identity, ever.
const registerLimit = createMemoryRateLimiter({ limit: 5, windowMs: 60_000 });
/**
 * Sponsored transfers per caller. Ten in ten minutes: comfortably above what a person sending funds
 * does, and low enough that a compromised session cannot drain the sponsor's DUST faster than the
 * host's own alerting notices. Unlike `/register` this is keyed on the session subject, not the
 * request, because the session is the only thing bounding the route at all.
 */
const transferLimit = createMemoryRateLimiter({ limit: 10, windowMs: 600_000 });

const handler = createHandler({
  auth: {
    domain,
    network,
    nonces: createNonceStore(),
    jwt: { privateKey, kid, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 60 * 60 },
  },
  publicJwk,
  store,
  devAuth,
  chain,
  notify,
  // Absent, not present-and-undefined: `artifacts` is only built when the chain is enabled, and
  // `exactOptionalPropertyTypes` distinguishes the two.
  registerLimit,
  transferLimit,
  ...(artifacts === undefined ? {} : { artifacts }),
});

// Wrapped rather than passed directly: Bun calls `fetch(req, server)` and the handler's second
// parameter is the request-lifetime hook, which on Node is not needed at all — a promise here lives
// until it settles. Handing Bun's `Server` in as that hook would type-check as nothing and read as
// something.
Bun.serve({ port, fetch: (request) => handler(request) });
console.log(
  `pnyx content service on :${port} (domain=${domain}, network=${network}, devAuth=${devAuth}, chain=${chain.enabled}, store=${dataFile})`,
);
