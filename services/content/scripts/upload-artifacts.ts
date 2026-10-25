// Upload a deployment's ZK artifacts to R2, so devices fetch them from a bucket instead of from the
// sponsor host (docs/cloudflare-migration-plan.md).
//
// What goes up, mirroring `pnyx-artifacts/origin.ts`'s R2 layout:
//   <target>/manifest.json                   — the artifact service's own manifest, verbatim
//   <target>/<circuit>.{bzkir,prover,verifier}
//   params/bls_midnight_2p<K>                — contract-independent, shared across deployments
//
// Keyed by contract TARGET (`identity`, `circle`), not by contract address. It used to be the
// address, which broke twice over once each circle became its own contract: a device would
// re-download an identical key set per circle, and a circle's keys are needed *before* its contract
// exists, so there is no address to key them by. The manifest's `codeDigest` is what distinguishes
// one compile from another now, and the app caches under it.
//
// ⚠️ `wrangler r2 object put` WITHOUT `--remote` writes the local miniflare simulation and prints
// "Upload complete." The real bucket stays empty and the custom domain 404s. Every put here passes
// `--remote`; do not remove it (this is a logged trap from the config/slow-data uploads).
//
// Usage, from the repo root:
//   bun services/content/scripts/upload-artifacts.ts --target circle [--bucket pnyx-artifacts] [--dry-run]
//
// The SRS is only uploaded when missing locally is not the case — i.e. it uploads whatever K files the
// manifest advertises. They are ~11 MB total and identical forever, so re-uploading is harmless.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactService } from '../src/artifacts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const target = arg('target');
const bucket = arg('bucket') ?? 'pnyx-artifacts';
const dryRun = process.argv.includes('--dry-run');

if (!target || !/^[a-z]+$/.test(target)) {
  console.error('--target <identity|circle> is required (it keys the upload path)');
  process.exit(1);
}

const managedDir = path.resolve(repoRoot, 'contract/managed', target);
const paramsDir = process.env.MIDNIGHT_PP ?? path.join(process.env.HOME ?? '', '.cache/midnight/zk-params');
const artifacts = createArtifactService(managedDir, target, paramsDir);
const manifest = artifacts.manifest();

// Circuit files and the SRS never change under a given key: the bytes are pinned by SHA-256 in the
// manifest and a recompile changes the manifest, so a year of edge caching costs nothing and
// saves a multi-MB origin read per device. Without a Cache-Control the custom domain answers
// `cf-cache-status: DYNAMIC` and every download reaches R2.
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The manifest is the one mutable object — a re-upload has to become visible — so it gets a short TTL
// instead. Five minutes matches the slow-data blobs on data.pxkq.uk.
const MANIFEST_CACHE = 'public, max-age=300';

const put = (key: string, file: string, contentType: string, cacheControl: string) => {
  const size = fs.statSync(file).size;
  console.log(`${dryRun ? 'would put' : 'put'} ${key} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  if (dryRun) return;
  // --remote is load-bearing; see the header.
  const res = spawnSync(
    'bunx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      file,
      '--content-type',
      contentType,
      '--cache-control',
      cacheControl,
      '--remote',
    ],
    { stdio: 'inherit', cwd: path.resolve(repoRoot, 'services/content') },
  );
  if (res.status !== 0) {
    console.error(`upload failed for ${key}`);
    process.exit(res.status ?? 1);
  }
};

// The manifest is written from the artifact service's own output, so what the bucket advertises is
// exactly what this deployment compiled — no hand-maintained second copy to drift.
const manifestPath = path.join(repoRoot, 'contract/managed/.r2-manifest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
put(`${target}/manifest.json`, manifestPath, 'application/json', MANIFEST_CACHE);

for (const circuit of Object.keys(manifest.circuits)) {
  for (const kind of ['bzkir', 'prover', 'verifier'] as const) {
    const file = artifacts.filePath(circuit, kind);
    if (file === undefined) {
      console.error(`artifact service has no ${kind} for ${circuit}`);
      process.exit(1);
    }
    put(`${target}/${circuit}.${kind}`, file, 'application/octet-stream', IMMUTABLE);
  }
}

for (const k of Object.keys(manifest.params)) {
  const file = artifacts.paramsPath(k);
  if (file === undefined) {
    console.error(`artifact service has no SRS for K=${k}`);
    process.exit(1);
  }
  put(`params/bls_midnight_2p${k}`, file, 'application/octet-stream', IMMUTABLE);
}

console.log(
  dryRun
    ? '\ndry run only — nothing uploaded'
    : `\nuploaded. Point builds at the bucket's public custom domain via EXPO_PUBLIC_ARTIFACTS_URL, ` +
        `then verify with: curl -sI <domain>/${target}/manifest.json`,
);
