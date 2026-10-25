// Mirror the ledger's **protocol** ZK circuits to R2, so a device can prove a shielded spend.
//
// These three — `midnight/zswap/{spend,output,sign}` — are not ours: they belong to the ledger, and
// upstream distributes them through its data provider. A device cannot reach that provider (it resolves
// paths from `$MIDNIGHT_PP` / `$HOME`, and we do not want the app depending on someone else's host), so
// they go on our own origin beside the contract circuits, in the same layout `pnyx-artifacts/origin.ts`
// fetches:
//
//   zswap/manifest.json
//   zswap/<spend|output|sign>.<bzkir|prover|verifier>
//   params/bls_midnight_2p<K>                          — shared, usually already uploaded
//
// **Mirroring is verified, not trusted.** The `midnight-zswap` crate pins every file's SHA-256 in
// `ZSWAP_EXPECTED_FILES`; the `zswap_manifest` example re-hashes what is on disk, refuses to emit a
// manifest if anything differs, and puts those same hashes in the manifest the device checks its
// downloads against. So a corrupt local cache cannot become a published artifact, and a substituted
// object cannot survive a download.
//
// ⚠️ `wrangler r2 object put` WITHOUT `--remote` writes the local miniflare simulation and prints
// "Upload complete." while the real bucket stays empty. Every put here passes `--remote`.
//
// Prime the local cache first (see `packages/midnight-native/rust/tests/spend_shielded_coin.rs`):
//   B=https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com
//   D=~/.cache/midnight/zk-params/zswap/9
//   mkdir -p $D && for c in spend output sign; do for k in bzkir prover verifier; do
//     curl -sS -o $D/$c.$k $B/zswap/9/$c.$k; done; done
//
// Usage, from the repo root:
//   bun services/content/scripts/upload-zswap-artifacts.ts [--version 9] [--bucket pnyx-artifacts] [--dry-run]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

// The ledger major that names the artifacts' path upstream. It is not a preference: a different major
// is a different set of circuits, and the app caches under it.
const version = arg('version') ?? '9';
const bucket = arg('bucket') ?? 'pnyx-artifacts';
const dryRun = process.argv.includes('--dry-run');

const paramsDir = process.env.MIDNIGHT_PP ?? path.join(process.env.HOME ?? '', '.cache/midnight/zk-params');
const artifactDir = path.join(paramsDir, 'zswap', version);

if (!fs.existsSync(artifactDir)) {
  console.error(`no artifacts at ${artifactDir} — prime the cache first (see this file's header)`);
  process.exit(1);
}

type ArtifactFile = { size: number; sha256: string };
type EmittedManifest = {
  target: string;
  codeDigest: string;
  circuits: Record<string, Record<string, ArtifactFile>>;
  srsK: string[];
};

// The Rust example is the source of truth for the hashes: it compares each file against the constant
// the crate pins and panics rather than emitting a manifest for bytes upstream never published.
const emitted = spawnSync(
  'cargo',
  ['run', '--quiet', '--example', 'zswap_manifest', '--', artifactDir],
  { cwd: path.resolve(repoRoot, 'packages/midnight-native/rust'), encoding: 'utf8' },
);
if (emitted.status !== 0) {
  console.error(emitted.stderr || 'zswap_manifest failed');
  process.exit(emitted.status ?? 1);
}
const manifest = JSON.parse(emitted.stdout.trim().split('\n').at(-1) ?? '{}') as EmittedManifest;

const sha256 = (file: string): ArtifactFile => ({
  size: fs.statSync(file).size,
  sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
});

// The SRS set comes from the circuits' own K, read from their zkir — not a table to drift.
const params: Record<string, ArtifactFile> = {};
for (const k of manifest.srsK) {
  const file = path.join(paramsDir, `bls_midnight_2p${k}`);
  if (!fs.existsSync(file)) {
    console.error(`missing SRS for K=${k} at ${file}`);
    process.exit(1);
  }
  params[k] = sha256(file);
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=300';

const put = (key: string, file: string, contentType: string, cacheControl: string) => {
  const size = fs.statSync(file).size;
  console.log(`${dryRun ? 'would put' : 'put'} ${key} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  if (dryRun) return;
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

for (const [circuit, kinds] of Object.entries(manifest.circuits)) {
  for (const kind of Object.keys(kinds)) {
    put(`zswap/${circuit}.${kind}`, path.join(artifactDir, `${circuit}.${kind}`), 'application/octet-stream', IMMUTABLE);
  }
}

// The SRS is shared with the contract circuits and usually already up; re-putting identical immutable
// bytes is harmless and keeps this script self-sufficient.
for (const k of Object.keys(params)) {
  put(`params/bls_midnight_2p${k}`, path.join(paramsDir, `bls_midnight_2p${k}`), 'application/octet-stream', IMMUTABLE);
}

// Written last, so a device can never read a manifest advertising files that are not there yet.
const finalManifest = {
  target: 'zswap',
  codeDigest: manifest.codeDigest,
  circuits: manifest.circuits,
  params,
};
const manifestPath = path.join(repoRoot, 'contract/managed/.r2-zswap-manifest.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
put('zswap/manifest.json', manifestPath, 'application/json', MANIFEST_CACHE);

console.log(
  dryRun
    ? '\ndry run only — nothing uploaded'
    : `\nuploaded ledger ${manifest.codeDigest} zswap circuits. Verify: curl -sI $EXPO_PUBLIC_ARTIFACTS_URL/zswap/manifest.json`,
);
