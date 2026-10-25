// Circuit-artifact manifest + file serving for the on-device-proving rail
// (GET /chain/artifacts/:target).
//
// The device proves circuits natively, so it needs each circuit's compile outputs — the ZK IR
// (`.bzkir`), the prover key (`.prover`), and the verifier key (`.verifier`) — which are versioned
// by the compiled contract (they must match the on-chain verifier keys). The service serves a
// manifest (per-file size + SHA-256, so the app can verify and cache) plus the files themselves,
// per target — `identity.compact` and `circle.compact` are separate contracts with separate keys.
//
// K (the SRS size a circuit needs) is deliberately NOT tied to circuits in the manifest: the app
// derives it from the downloaded `.bzkir` via the native `circuit_k`. The SRS (KZG params) itself is
// contract-independent and fetched separately by K (`GET /chain/params/:k`); the manifest lists the
// available SRS files (by K) with their hashes so the app can verify + cache them too. A hardcoded
// K-per-circuit table would drift on every `compile:contract`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ArtifactFile = {
  readonly size: number;
  readonly sha256: string;
};

export type CircuitArtifacts = {
  readonly bzkir: ArtifactFile;
  readonly prover: ArtifactFile;
  readonly verifier: ArtifactFile;
};

export type ArtifactManifest = {
  /** Which contract these artifacts compile — `identity` or `circle`. */
  readonly target: string;
  /**
   * SHA-256 over every circuit's verifier key, in circuit order — the compiled **code's** identity.
   *
   * Artifacts used to be keyed by the deployed contract address, which was right while one contract
   * served the whole forum. With one contract per circle it is wrong twice over: the device would
   * re-download an identical 53 MB key set for every circle it touched, and a circle's keys are needed
   * *before* its contract exists, so there is no address to key them by yet.
   *
   * The verifier keys ARE the code (they are what the address commits to via `operations`), so
   * hashing them gives a key that changes on exactly the event that should invalidate a cache — a
   * recompile — and is shared by every deployment of the same contract.
   */
  readonly codeDigest: string;
  readonly circuits: Readonly<Record<string, CircuitArtifacts>>;
  /** Available KZG SRS files keyed by K (as a string) — contract-independent, served by K. */
  readonly params: Readonly<Record<string, ArtifactFile>>;
};

/** SRS filename convention: `bls_midnight_2p<K>` (the MidnightDataProvider cache layout). */
const SRS_PREFIX = 'bls_midnight_2p';

/** The three per-circuit artifact kinds and their location under the managed dir. */
export const ARTIFACT_KINDS = {
  bzkir: { dir: 'zkir', ext: '.bzkir' },
  prover: { dir: 'keys', ext: '.prover' },
  verifier: { dir: 'keys', ext: '.verifier' },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_KINDS;

export const isArtifactKind = (value: string): value is ArtifactKind =>
  Object.hasOwn(ARTIFACT_KINDS, value);

export type ArtifactService = {
  /** The manifest (computed once, memoized — the managed dir is static per deployment). */
  manifest(): ArtifactManifest;
  /**
   * Absolute path for a validated (circuit, kind), or undefined if the circuit is not in the
   * manifest / the kind is unknown. `circuit` and `kind` are validated against the known set, so
   * no untrusted path component reaches the filesystem.
   */
  filePath(circuit: string, kind: string): string | undefined;
  /**
   * Absolute path to the SRS file for `k`, or undefined if that K is not available. `k` is
   * validated against the discovered set, so no untrusted path component reaches the filesystem.
   */
  paramsPath(k: string): string | undefined;
};

const hashFile = (filePath: string): ArtifactFile => {
  const bytes = readFileSync(filePath);
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

/**
 * Build an artifact service over one compiled contract's `managed/<target>` directory. Circuits are
 * discovered from `keys/*.prover` (drift-free: it reflects exactly what was compiled). Throws if the
 * managed dir or any expected per-circuit file is missing — a target that can't serve complete
 * artifacts should fail loudly, not hand the device a partial set.
 *
 * One service per contract: `identity` and `circle` have disjoint circuit sets and separate digests.
 */
export const createArtifactService = (
  managedDir: string,
  target: string,
  paramsDir?: string,
): ArtifactService => {
  if (!existsSync(managedDir)) {
    throw new Error(`artifact service: managed dir ${managedDir} does not exist (run \`bun run compile:contract\`)`);
  }
  const keysDir = path.join(managedDir, 'keys');
  const circuits = readdirSync(keysDir)
    .filter((name) => name.endsWith('.prover'))
    .map((name) => name.slice(0, -'.prover'.length))
    .sort();

  // SRS files (`bls_midnight_2p<K>`) discovered from the params dir (the MidnightDataProvider cache).
  // Absent dir → no params served (the manifest's `params` is empty); the app then can't fetch the
  // SRS and must obtain it another way, so this is logged loudly at startup by the caller.
  const paramKs =
    paramsDir && existsSync(paramsDir)
      ? readdirSync(paramsDir)
          .filter((name) => name.startsWith(SRS_PREFIX) && /^\d+$/.test(name.slice(SRS_PREFIX.length)))
          .map((name) => name.slice(SRS_PREFIX.length))
          .sort((a, b) => Number(a) - Number(b))
      : [];

  const resolve = (circuit: string, kind: ArtifactKind): string => {
    const { dir, ext } = ARTIFACT_KINDS[kind];
    return path.join(managedDir, dir, `${circuit}${ext}`);
  };
  const resolveParams = (k: string): string => path.join(paramsDir ?? '', `${SRS_PREFIX}${k}`);

  let cached: ArtifactManifest | undefined;
  const manifest = (): ArtifactManifest => {
    if (!cached) {
      const entries: Record<string, CircuitArtifacts> = {};
      for (const circuit of circuits) {
        const files = { bzkir: resolve(circuit, 'bzkir'), prover: resolve(circuit, 'prover'), verifier: resolve(circuit, 'verifier') };
        for (const [kind, p] of Object.entries(files)) {
          if (!existsSync(p) || !statSync(p).isFile()) {
            throw new Error(`artifact service: ${circuit} is missing its ${kind} artifact at ${p}`);
          }
        }
        entries[circuit] = {
          bzkir: hashFile(files.bzkir),
          prover: hashFile(files.prover),
          verifier: hashFile(files.verifier),
        };
      }
      const params: Record<string, ArtifactFile> = {};
      for (const k of paramKs) {
        params[k] = hashFile(resolveParams(k));
      }
      // Digest over the verifier keys only, in circuit order: they are the contract's code identity,
      // and unlike the prover keys they are what the on-chain `operations` map carries.
      const digest = createHash('sha256');
      for (const circuit of circuits) {
        digest.update(circuit).update(entries[circuit]?.verifier.sha256 ?? '');
      }
      cached = { target, codeDigest: digest.digest('hex'), circuits: entries, params };
    }
    return cached;
  };

  return {
    manifest,
    filePath: (circuit, kind) => {
      if (!isArtifactKind(kind) || !circuits.includes(circuit)) {
        return undefined;
      }
      return resolve(circuit, kind);
    },
    paramsPath: (k) => (paramKs.includes(k) ? resolveParams(k) : undefined),
  };
};
